import { assert, expect } from "chai";
import { JsonRpcProvider, JsonRpcSigner, ZeroAddress, parseUnits } from "ethers";
import { StETH, StETH__factory, WithdrawalQueue, WithdrawalQueue__factory } from "../typechain-types";
import { protocolConfig } from "./setup/config.mainnet";

const STETH_BALANCE_ERROR_MARGIN = 2n;
const PRECISION_FACTOR = 10n ** 27n;

describe("WithdrawalQueue", function () {
  const {
    stETH: {
      proxy: { address: stethAddress },
    },
    withdrawalQueue: {
      proxy: { address: withdrawalQueueAddress },
    },
  } = protocolConfig;

  const provider = new JsonRpcProvider("http://127.0.0.1:8545", "mainnet", {
    cacheTimeout: 0, // disable cache to avoid stale balances
  });

  let initialForkStateSnapshotId: string;

  // signers
  let staker: JsonRpcSigner;
  let stethAsSigner: JsonRpcSigner;

  // contracts
  let steth: StETH;
  let withdrawalQueue: WithdrawalQueue;

  this.beforeAll(async function () {
    initialForkStateSnapshotId = await provider.send("evm_snapshot", []);

    // to avoid extra calculations, we will finalize the current withdrawal requests beforehand,
    // so that we're dealing with a single withdrawal request in this test
    staker = await provider.getSigner();

    // set up contracts
    steth = StETH__factory.connect(stethAddress, staker);
    withdrawalQueue = WithdrawalQueue__factory.connect(withdrawalQueueAddress, staker);

    await provider.send("anvil_impersonateAccount", [stethAddress]);
    stethAsSigner = new JsonRpcSigner(provider, stethAddress);

    // rate = totalShares * precisionFactor / totalShares
    const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
    const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
    const lastUnfinalizedWithdrawalRequestId = await withdrawalQueue.getLastRequestId();

    const { ethToLock } = await withdrawalQueue.prefinalize([lastUnfinalizedWithdrawalRequestId], currentShareRate);

    // top up Lido buffer by simulating a whale submit
    const ethWhaleAddress = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // deposit contract 😏
    const ethWhaleBalance = await provider.getBalance(ethWhaleAddress);
    expect(ethWhaleBalance).to.be.greaterThanOrEqual(
      ethToLock,
      "Make sure the whale has enough ether required for finalization",
    );
    await provider.send("anvil_impersonateAccount", [ethWhaleAddress]);
    const ethWhale = await provider.getSigner(ethWhaleAddress);
    await ethWhale.sendTransaction({
      to: stethAddress,
      value: ethToLock,
    });

    await withdrawalQueue.connect(stethAsSigner).finalize(lastUnfinalizedWithdrawalRequestId, currentShareRate);
    const lastFinalizedWithdrawalRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    expect(lastFinalizedWithdrawalRequestId).to.equal(lastUnfinalizedWithdrawalRequestId);
  });

  this.afterAll(async () => {
    await provider.send("evm_revert", [initialForkStateSnapshotId]);
  });

  it("allows the staker to go through the entire flow from stake to claim", async function () {
    // * * * STAKE * * * *
    const STAKE_AMOUNT = parseUnits("10.0", "ether");

    const stakerStethBalanceBeforeStake = await steth.balanceOf(staker.address);
    const stakerEthBalanceBeforeStake = await provider.getBalance(staker.address);

    const stakeTx = await steth.submit(ZeroAddress, {
      value: STAKE_AMOUNT,
    });
    const stakeTxReceipt = await stakeTx.wait();

    const stakerStethBalanceAfterStake = await steth.balanceOf(staker.address);
    const stakerEthBalanceAfterStake = await provider.getBalance(staker.address);

    expect(STAKE_AMOUNT - stakerStethBalanceAfterStake - stakerStethBalanceBeforeStake).to.be.lessThanOrEqual(
      STETH_BALANCE_ERROR_MARGIN,
      "Staker stETH balance after stake is updated by the amount staked within the stETH balance error margin",
    );

    expect(stakerEthBalanceAfterStake).to.be.equal(
      stakerEthBalanceBeforeStake - STAKE_AMOUNT - stakeTxReceipt!.fee,
      "Staker ETH balance after stake decreases by the amount staked and the tx fee",
    );

    // * * * SUBMIT WITHDRAWAL REQUEST * * *

    // give withdrawal queue allowance
    const allowanceBeforeApprove = await steth.allowance(staker.address, withdrawalQueueAddress);
    const approveTx = await steth.approve(withdrawalQueueAddress, STAKE_AMOUNT);
    const approveTxReceipt = await approveTx.wait();
    const allowanceAfterApprove = await steth.allowance(staker.address, withdrawalQueueAddress);
    const stakerEthBalanceAfterApprove = await provider.getBalance(staker.address);
    expect(allowanceAfterApprove).to.equal(
      allowanceBeforeApprove + STAKE_AMOUNT,
      "WithdrawalQueue allowance given by staker was increased by the amount of stake",
    );
    expect(stakerEthBalanceAfterApprove).to.equal(
      stakerEthBalanceAfterStake - approveTxReceipt!.fee,
      "Approve tx fee was deducted from the staker's ETH balance",
    );

    // make sure the staker has no withdrawal requests submitted
    const stakerRequestIdsBeforeWithdrawalRequest = await withdrawalQueue.getWithdrawalRequests(staker.address);
    expect(stakerRequestIdsBeforeWithdrawalRequest.length).to.equal(
      0,
      "Staker does not have withdrawal requests submitted",
    );

    // submit withdrawal request
    const withdrawalRequests = [STAKE_AMOUNT];
    const requestTx = await withdrawalQueue.requestWithdrawals(withdrawalRequests, staker.address);
    const requestTxReceipt = await requestTx.wait();
    const lastRequestId = await withdrawalQueue.getLastRequestId();
    const stakerRequestIds = await withdrawalQueue.getWithdrawalRequests(staker.address);
    const stakerRequestId = stakerRequestIds[0];
    expect(stakerRequestIds.length).to.equal(
      withdrawalRequests.length,
      "Only 1 withdrawal request submitted by the staker",
    );
    expect(lastRequestId).to.equal(stakerRequestId, "Last request id matches the staker's request id");
    const stakerEthBalanceAfterRequest = await provider.getBalance(staker.address);
    expect(stakerEthBalanceAfterRequest).to.equal(stakerEthBalanceAfterApprove - requestTxReceipt!.fee);

    // finalize requests
    // for some reason ethers throws an exception when tx.from != contract.signer,
    // so we have instantiate WQ with steth as signer
    const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
    const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
    const { ethToLock: stakerClaimableEth } = await withdrawalQueue.prefinalize([stakerRequestId], currentShareRate);
    await withdrawalQueue.connect(stethAsSigner).finalize(stakerRequestId, currentShareRate);
    const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    assert(stakerRequestId === lastFinalizedRequestId);

    // claim eth
    const claimTx = await withdrawalQueue.claimWithdrawal(stakerRequestId, { from: staker.address });
    const claimTxReceipt = await claimTx.wait();
    const stakerEthBalanceAfterClaim = await provider.getBalance(staker.address);
    expect(stakerEthBalanceAfterClaim).to.equal(
      stakerEthBalanceAfterRequest + stakerClaimableEth - claimTxReceipt!.fee,
      "Staker eth balance after claim increased by the amount of eth owed according to the finalization share rate with the claim fee deducted",
    );
  });
});
