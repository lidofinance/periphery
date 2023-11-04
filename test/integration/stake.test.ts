import { expect } from "chai";
import { ContractTransactionResponse, JsonRpcProvider, JsonRpcSigner, ZeroAddress, parseUnits } from "ethers";
import { describe } from "mocha";
import {
  DepositSecurityModule,
  DepositSecurityModule__factory,
  StETH,
  StETH__factory,
  WithdrawalQueue,
  WithdrawalQueue__factory,
} from "../../typechain-types";
import { impersonate } from "../helpers/account";
import { parseLogs } from "../helpers/logs";
import { promiseAllValues } from "../helpers/misc";
import { protocolConfig } from "../setup/config.mainnet";

const STETH_BALANCE_MAX_WEI_ERROR = 2n;
const PRECISION_FACTOR = 10n ** 27n;
// const MAX_UINT256 = 2n ** 256n - 1n;
const WHALE_ADDRESS = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // deposit contract 😏
const CURATED_MODULE_ID = 1n;

describe("Stake", function () {
  const {
    stETH: {
      proxy: { address: stethAddress },
    },
    withdrawalQueue: {
      proxy: { address: withdrawalQueueAddress },
    },
    depositSecurityModule: {
      implementation: { address: depositSecurityModuleAddress },
    },
  } = protocolConfig;

  const provider = new JsonRpcProvider("http://127.0.0.1:8545", "mainnet", {
    cacheTimeout: 0, // disable cache to avoid stale balances
  });

  // signers
  let staker: JsonRpcSigner;
  let whale: JsonRpcSigner;
  let stethAsSigner: JsonRpcSigner;
  let dsmAsSigner: JsonRpcSigner;

  // amounts
  const stakeAmount = parseUnits("10.0", "ether");

  // contracts
  let steth: StETH;
  let withdrawalQueue: WithdrawalQueue;
  let depositSecurityModule: DepositSecurityModule;

  // snapshots
  let initialForkStateSnapshotId: string;

  this.beforeAll(async function () {
    initialForkStateSnapshotId = await provider.send("evm_snapshot", []);

    // * * * INSTANTIATE ACCOUNTS * * *
    staker = await provider.getSigner();
    whale = await impersonate(WHALE_ADDRESS, provider);
    stethAsSigner = await impersonate(stethAddress, provider);
    dsmAsSigner = await impersonate(depositSecurityModuleAddress, provider);

    // * * * INSTANTIATE CONTRACTS * * *
    steth = StETH__factory.connect(stethAddress, staker);
    withdrawalQueue = WithdrawalQueue__factory.connect(withdrawalQueueAddress, staker);
    depositSecurityModule = DepositSecurityModule__factory.connect(depositSecurityModuleAddress, provider);

    // * * * FINALIZE CURRENT WITHDRAWAL REQUESTS * * *

    const [lastUnfinalizedRequestId, lastFinalizedRequestIdBeforeFinalize] = await Promise.all([
      withdrawalQueue.getLastRequestId(),
      withdrawalQueue.getLastFinalizedRequestId(),
    ]);

    // TODO: don't use return
    if (lastUnfinalizedRequestId === lastFinalizedRequestIdBeforeFinalize) {
      // Nothing to finalize
      return;
    }

    const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
    const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
    const { ethToLock, sharesToBurn } = await withdrawalQueue.prefinalize([lastUnfinalizedRequestId], currentShareRate);

    // top up Lido buffer by simulating a whale submit
    const whaleBalance = await provider.getBalance(whale.address);
    expect(whaleBalance).to.be.greaterThanOrEqual(ethToLock);
    await steth.connect(whale).submit(ZeroAddress, { value: ethToLock });

    const finalizeTxReceipt = await withdrawalQueue
      .connect(stethAsSigner)
      .finalize(lastUnfinalizedRequestId, currentShareRate, {
        value: ethToLock,
      })
      .then(receipt);

    const lastFinalizedRequestIdAfterFinalize = await withdrawalQueue.getLastFinalizedRequestId();
    const finalizeBlockTimestamp = BigInt((await finalizeTxReceipt!.getBlock()).timestamp);
    const finalizeLogs = parseLogs(finalizeTxReceipt, [withdrawalQueue]);

    expect(lastFinalizedRequestIdAfterFinalize).to.equal(lastUnfinalizedRequestId);

    expect(finalizeLogs.length).to.equal(2);

    expect(finalizeLogs[0]?.name).to.equal("WithdrawalsFinalized");
    expect(finalizeLogs[0]?.args.toArray()).to.deep.equal([
      lastFinalizedRequestIdBeforeFinalize + 1n,
      lastFinalizedRequestIdAfterFinalize,
      ethToLock,
      sharesToBurn,
      finalizeBlockTimestamp,
    ]);

    expect(finalizeLogs[1]?.name).to.equal("BatchMetadataUpdate");
    expect(finalizeLogs[1]?.args.toArray()).to.deep.equal([
      lastFinalizedRequestIdBeforeFinalize + 1n,
      lastFinalizedRequestIdAfterFinalize,
    ]);
  });

  this.afterAll(async () => {
    await provider.send("evm_revert", [initialForkStateSnapshotId]);
  });

  it.only("Stake -> Deposit -> Rebase", async function () {
    async function getStethState() {
      return await promiseAllValues({
        stakerStethBalance: steth.balanceOf(staker.address),
        stakerShares: steth.sharesOf(staker.address),
        stakerEthBalance: provider.getBalance(staker.address),
        totalSupply: steth.totalSupply(),
        bufferedEther: steth.getBufferedEther(),
        stakeLimit: steth.getCurrentStakeLimit(),
        stakeAmountInShares: steth.getSharesByPooledEth(stakeAmount),
      });
    }

    const before = await getStethState();

    const { maxStakeLimit, maxStakeLimitGrowthBlocks } = await steth.getStakeLimitFullInfo();
    const growthPerBlock = maxStakeLimit / maxStakeLimitGrowthBlocks;

    const stakeTxReceipt = await steth.submit(ZeroAddress, { value: stakeAmount }).then(receipt);

    const after = await getStethState();

    expect(stakeAmount - after.stakerStethBalance - before.stakerEthBalance).to.be.lessThanOrEqual(
      STETH_BALANCE_MAX_WEI_ERROR,
    );
    expect(after.stakerEthBalance).to.equal(before.stakerEthBalance - stakeAmount - stakeTxReceipt!.fee);

    expect(before.stakeAmountInShares).to.equal(after.stakeAmountInShares);
    expect(after.stakerShares).to.equal(before.stakerShares + before.stakeAmountInShares);

    expect(after.totalSupply).to.equal(before.totalSupply + stakeAmount);
    expect(after.bufferedEther).to.be.equal(before.bufferedEther + stakeAmount);

    if (before.stakeLimit >= maxStakeLimit - growthPerBlock) {
      expect(after.stakeLimit).to.equal(before.stakeLimit - stakeAmount);
    } else {
      expect(after.stakeLimit).to.equal(before.stakeLimit - stakeAmount + growthPerBlock);
    }

    const stakeLogs = parseLogs(stakeTxReceipt, [steth]);
    expect(stakeLogs.length).to.equal(3);

    expect(stakeLogs[0]?.name).to.equal("Submitted");
    expect(stakeLogs[0]?.args.toArray()).to.deep.equal([staker.address, stakeAmount, ZeroAddress]);

    expect(stakeLogs[1]?.name).to.equal("Transfer");
    expect(stakeLogs[1]?.args.toArray()).to.deep.equal([
      ZeroAddress,
      staker.address,
      after.stakerStethBalance - before.stakerStethBalance,
    ]);

    expect(stakeLogs[2]?.name).to.equal("TransferShares");
    expect(stakeLogs[2]?.args.toArray()).to.deep.equal([ZeroAddress, staker.address, after.stakeAmountInShares]);

    const [
      // { depositedValidators: depositedValidatorsBeforeDeposit },
      depositableEtherBeforeDeposit,
      unfinalizedStETH,
      maxDeposits,
    ] = await Promise.all([
      // steth.getBeaconStat(),
      steth.getDepositableEther(),
      withdrawalQueue.unfinalizedStETH(),
      depositSecurityModule.getMaxDeposits(),
    ]);

    expect(depositableEtherBeforeDeposit).to.equal(after.bufferedEther - unfinalizedStETH);

    const depositSecurityModuleBalance = await provider.getBalance(depositSecurityModuleAddress);
    console.log({ depositSecurityModuleAddress, depositSecurityModuleBalance });

    // TODO: topup depositSecurityModule balance (neither of the sendTransaction-s below works)
    // await staker.sendTransaction({ to: depositSecurityModuleAddress, value: parseUnits("10.0", "ether") })
    // await whale.sendTransaction({ value: parseUnits("10.0", "ether"), to: depositSecurityModuleAddress })
    return;

    const depositTxReceipt = await steth
      .connect(dsmAsSigner)
      .deposit(maxDeposits, CURATED_MODULE_ID, "0x00")
      .then(receipt);

    const depositLogs = parseLogs(depositTxReceipt, [steth]);
    console.log(depositLogs);
  });
});

function receipt(contractTransactionResponse: ContractTransactionResponse) {
  return contractTransactionResponse.wait();
}
