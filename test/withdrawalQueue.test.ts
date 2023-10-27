import { bigintToHex } from "bigint-conversion";
import { expect } from "chai";
import { ecsign } from "ethereumjs-util";
import {
  AbiCoder,
  BaseContract,
  ContractTransactionReceipt,
  ContractTransactionResponse,
  HDNodeWallet,
  JsonRpcProvider,
  JsonRpcSigner,
  Wallet,
  ZeroAddress,
  keccak256,
  parseUnits,
  toUtf8Bytes,
} from "ethers";
import { StETH, StETH__factory, WithdrawalQueue, WithdrawalQueue__factory } from "../typechain-types";
import { protocolConfig } from "./setup/config.mainnet";

const STETH_BALANCE_ERROR_MARGIN = 2n;
const PRECISION_FACTOR = 10n ** 27n;
const MAX_UINT256 = 2n ** 256n - 1n;

xdescribe("WithdrawalQueue", function () {
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

  context("Withdraw flows", function () {
    let allWithdrawalRequestsFinalizedSnapshotId: string;

    // signers
    let staker: HDNodeWallet;
    let stethAsSigner: JsonRpcSigner;
    let ethWhale: JsonRpcSigner;

    // contracts
    let steth: StETH;
    let withdrawalQueue: WithdrawalQueue;

    // constant values
    const stakeAmount = parseUnits("10.0", "ether");

    let stakeAmountInShares: bigint;
    let stakerStethBalanceBeforeStake: bigint;
    let stakerSharesBeforeStake: bigint;
    let stakerEthBalanceBeforeStake: bigint;

    let stakerStethBalanceAfterStake: bigint;
    let stakerSharesAfterStake: bigint;
    let stakerEthBalanceAfterStake: bigint;

    this.beforeAll(async function () {
      initialForkStateSnapshotId = await provider.send("evm_snapshot", []);

      // to avoid extra calculations, we will finalize the current withdrawal requests beforehand,
      // so that we're dealing with a single withdrawal request in this test

      // provider.getSigner() does not give access to its PK, which is why
      // we create a random wallet because we will need its PK for signing stETH permit
      staker = Wallet.createRandom(provider);

      // top up the staker account
      const sponsor = await provider.getSigner();
      sponsor.sendTransaction({
        to: staker.address,
        value: parseUnits("100.0", "ether"),
      });

      // set up contracts
      steth = StETH__factory.connect(stethAddress, staker);
      withdrawalQueue = WithdrawalQueue__factory.connect(withdrawalQueueAddress, staker);

      await provider.send("anvil_impersonateAccount", [stethAddress]);
      stethAsSigner = new JsonRpcSigner(provider, stethAddress);

      const ethWhaleAddress = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // deposit contract 😏
      await provider.send("anvil_impersonateAccount", [ethWhaleAddress]);
      ethWhale = await provider.getSigner(ethWhaleAddress);

      // * * * STAKE * * * *
      const stakeReferral = ZeroAddress;
      [stakerStethBalanceBeforeStake, stakerSharesBeforeStake, stakerEthBalanceBeforeStake] = await Promise.all([
        steth.balanceOf(staker.address),
        steth.sharesOf(staker.address),
        provider.getBalance(staker.address),
      ]);

      const stakeTxReceipt = await steth
        .submit(stakeReferral, {
          value: stakeAmount,
        })
        .then(receipt);
      [stakerStethBalanceAfterStake, stakerSharesAfterStake, stakerEthBalanceAfterStake] = await Promise.all([
        steth.balanceOf(staker.address),
        steth.sharesOf(staker.address),
        provider.getBalance(staker.address),
      ]);

      const stakeLogs = parseLogs(stakeTxReceipt, [steth]);
      stakeAmountInShares = stakerSharesAfterStake - stakerSharesBeforeStake;

      expect(stakeAmount - stakerStethBalanceAfterStake - stakerStethBalanceBeforeStake).to.be.lessThanOrEqual(
        STETH_BALANCE_ERROR_MARGIN,
      );
      expect(stakerEthBalanceAfterStake).to.be.equal(stakerEthBalanceBeforeStake - stakeAmount - stakeTxReceipt!.fee);

      expect(stakeLogs.length).to.equal(3);

      expect(stakeLogs[0]?.name).to.equal("Submitted");
      expect(stakeLogs[0]?.args.toArray()).to.deep.equal([staker.address, stakeAmount, stakeReferral]);

      expect(stakeLogs[1]?.name).to.equal("Transfer");
      expect(stakeLogs[1]?.args.toArray()).to.deep.equal([
        ZeroAddress,
        staker.address,
        stakerStethBalanceAfterStake - stakerStethBalanceBeforeStake,
      ]);

      expect(stakeLogs[2]?.name).to.equal("TransferShares");
      expect(stakeLogs[2]?.args.toArray()).to.deep.equal([ZeroAddress, staker.address, stakeAmountInShares]);

      allWithdrawalRequestsFinalizedSnapshotId = await provider.send("evm_snapshot", []);
    });

    this.afterAll(async () => {
      await provider.send("evm_revert", [initialForkStateSnapshotId]);
    });

    this.beforeEach(async () => {
      await provider.send("evm_revert", [allWithdrawalRequestsFinalizedSnapshotId]);
    });

    it("allows the staker to go through the entire flow from stake to claim", async function () {
      // * * * SUBMIT WITHDRAWAL REQUEST * * *

      // give withdrawal queue allowance
      const allowanceBeforeApprove = await steth.allowance(staker.address, withdrawalQueueAddress);

      const approveTxReceipt = await steth.approve(withdrawalQueueAddress, stakeAmount).then(receipt);

      const [allowanceAfterApprove, stakerEthBalanceAfterApprove] = await Promise.all([
        steth.allowance(staker.address, withdrawalQueueAddress),
        provider.getBalance(staker.address),
      ]);

      const approveLogs = parseLogs(approveTxReceipt, [steth]);

      expect(approveLogs.length).to.equal(1);
      expect(approveLogs[0]?.name).to.equal("Approval");
      expect(approveLogs[0]?.args.toArray()).to.deep.equal([staker.address, withdrawalQueueAddress, stakeAmount]);

      expect(allowanceAfterApprove).to.equal(allowanceBeforeApprove + stakeAmount);
      expect(stakerEthBalanceAfterApprove).to.equal(stakerEthBalanceAfterStake - approveTxReceipt!.fee);

      // make sure the staker has no withdrawal requests submitted
      const stakerRequestIdsBeforeWithdrawalRequest = await withdrawalQueue.getWithdrawalRequests(staker.address);
      expect(stakerRequestIdsBeforeWithdrawalRequest.length).to.equal(0);

      // submit withdrawal request
      const withdrawalRequests = [stakeAmount];
      const requestTxReceipt = await withdrawalQueue
        .requestWithdrawals(withdrawalRequests, staker.address)
        .then(receipt);

      const lastRequestId = await withdrawalQueue.getLastRequestId();
      const stakerEthBalanceAfterRequest = await provider.getBalance(staker.address);
      const requestLogs = parseLogs(requestTxReceipt, [steth, withdrawalQueue]);

      const stakerRequestIds = await withdrawalQueue.getWithdrawalRequests(staker.address);

      expect(stakerRequestIds.length).to.equal(withdrawalRequests.length);
      const stakerRequestId = stakerRequestIds[0];
      expect(lastRequestId).to.equal(stakerRequestId);
      expect(stakerEthBalanceAfterRequest).to.equal(stakerEthBalanceAfterApprove - requestTxReceipt!.fee);

      expect(requestLogs.length).to.equal(5);

      expect(requestLogs[0]?.name).to.equal("Approval");
      expect(requestLogs[0]?.args.toArray()).to.deep.equal([
        staker.address,
        withdrawalQueueAddress,
        allowanceAfterApprove - stakeAmount,
      ]);

      expect(requestLogs[1]?.name).to.equal("Transfer");
      expect(requestLogs[1]?.args.toArray()).to.deep.equal([staker.address, withdrawalQueueAddress, stakeAmount]);

      expect(requestLogs[2]?.name).to.equal("TransferShares");
      expect(requestLogs[2]?.args.toArray()).to.deep.equal([
        staker.address,
        withdrawalQueueAddress,
        stakeAmountInShares,
      ]);

      expect(requestLogs[3]?.name).to.equal("WithdrawalRequested");
      expect(requestLogs[3]?.args.toArray()).to.deep.equal([
        stakerRequestId,
        staker.address,
        staker.address,
        stakeAmount,
        stakeAmountInShares,
      ]);

      expect(requestLogs[4]?.name).to.equal("Transfer");
      expect(requestLogs[4]?.args.toArray()).to.deep.equal([ZeroAddress, staker.address, stakerRequestId]);

      // * * * FINALIZE WITHDRAWAL REQUEST * * *

      const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
      const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
      const { ethToLock, sharesToBurn } = await withdrawalQueue.prefinalize([stakerRequestId], currentShareRate);

      // top up Lido buffer by simulating a whale submit
      const ethWhaleBalance = await provider.getBalance(ethWhale.address);
      expect(ethWhaleBalance).to.be.greaterThanOrEqual(ethToLock);
      await steth.connect(ethWhale).submit(ZeroAddress, { value: ethToLock });

      const lastFinalizedRequestIdBeforeFinalize = await withdrawalQueue.getLastFinalizedRequestId();

      const finalizeTxReceipt = await withdrawalQueue
        .connect(stethAsSigner)
        .finalize(stakerRequestId, currentShareRate, {
          value: ethToLock,
        })
        .then(receipt);

      const stakerClaimableEth = (currentShareRate * stakeAmountInShares) / PRECISION_FACTOR;
      const lastFinalizedRequestIdAfterFinalize = await withdrawalQueue.getLastFinalizedRequestId();
      const finalizeBlockTimestamp = BigInt((await finalizeTxReceipt!.getBlock()).timestamp);
      const finalizeLogs = parseLogs(finalizeTxReceipt, [withdrawalQueue]);

      expect(lastFinalizedRequestIdAfterFinalize).to.equal(stakerRequestId);

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

      // * * * CLAIM ETH * * *
      const claimTxReceipt = await withdrawalQueue
        .claimWithdrawal(stakerRequestId, { from: staker.address })
        .then(receipt);

      const stakerEthBalanceAfterClaim = await provider.getBalance(staker.address);
      const claimLogs = parseLogs(claimTxReceipt, [withdrawalQueue]);

      expect(stakerEthBalanceAfterClaim).to.equal(
        stakerEthBalanceAfterRequest + stakerClaimableEth - claimTxReceipt!.fee,
      );

      expect(claimLogs.length).to.equal(2);

      expect(claimLogs[0]?.name).to.equal("WithdrawalClaimed");
      expect(claimLogs[0]?.args.toArray()).to.deep.equal([
        stakerRequestId,
        staker.address,
        staker.address,
        stakerClaimableEth,
      ]);
    });

    it("allows claiming eth from another account via permit", async function () {
      // * * * SIGN EIP-721 PERMIT * * * *
      const stethDomainSeparator = await steth.DOMAIN_SEPARATOR();
      const permitType = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";
      const permitTypeHash = keccak256(toUtf8Bytes(permitType));
      const stakeInHex = bigintToHex(stakeAmount, true);
      const nonceInHex = bigintToHex(0n, true);
      const deadlineInHex = bigintToHex(MAX_UINT256, true);
      const parameters = keccak256(
        new AbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
          [permitTypeHash, staker.address, withdrawalQueueAddress, stakeInHex, nonceInHex, deadlineInHex],
        ),
      );
      const message = keccak256("0x1901" + strip0x(stethDomainSeparator) + strip0x(parameters));
      const { v, r, s } = ecsign(Buffer.from(strip0x(message), "hex"), Buffer.from(strip0x(staker.privateKey), "hex"));

      const permit = {
        value: stakeAmount,
        deadline: deadlineInHex,
        v,
        r,
        s,
      };

      // * * * SUBMIT WITHDRAW REQUEST WITH PERMIT * * * *
      const claimer = await provider.getSigner();

      // make sure the claimer has no withdrawal requests
      const claimerRequestIdsBeforeWithdrawalRequest = await withdrawalQueue.getWithdrawalRequests(claimer.address);
      expect(claimerRequestIdsBeforeWithdrawalRequest.length).to.equal(0, "Claimer does not have withdrawal requests");

      // submit withdrawal request from the staker to claim by the claimer
      const withdrawalRequests = [stakeAmount];
      const requestTxReceipt = await withdrawalQueue
        .requestWithdrawalsWithPermit(withdrawalRequests, claimer.address, permit)
        .then(receipt);

      const lastRequestId = await withdrawalQueue.getLastRequestId();
      const claimerRequestIds = await withdrawalQueue.getWithdrawalRequests(claimer.address);
      const claimerRequestId = claimerRequestIds[0];
      expect(claimerRequestIds.length).to.equal(
        withdrawalRequests.length,
        "Only 1 withdrawal request submitted by the staker",
      );
      expect(lastRequestId).to.equal(claimerRequestId, "Last request id matches the claimer's request id");
      const stakerEthBalanceAfterRequest = await provider.getBalance(staker.address);
      expect(stakerEthBalanceAfterRequest).to.equal(stakerEthBalanceAfterStake - requestTxReceipt!.fee);

      // * * * FINALIZE WITHDRAWAL REQUEST * * *

      const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
      const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
      const { ethToLock, sharesToBurn } = await withdrawalQueue.prefinalize([claimerRequestId], currentShareRate);

      // top up Lido buffer by simulating a whale submit
      const ethWhaleBalance = await provider.getBalance(ethWhale.address);
      expect(ethWhaleBalance).to.be.greaterThanOrEqual(ethToLock);
      await steth.connect(ethWhale).submit(ZeroAddress, { value: ethToLock });

      const lastFinalizedRequestIdBeforeFinalize = await withdrawalQueue.getLastFinalizedRequestId();

      const finalizeTxReceipt = await withdrawalQueue
        .connect(stethAsSigner)
        .finalize(claimerRequestId, currentShareRate, {
          value: ethToLock,
        })
        .then(receipt);

      const claimerClaimableEth = (currentShareRate * stakeAmountInShares) / PRECISION_FACTOR;
      const lastFinalizedRequestIdAfterFinalize = await withdrawalQueue.getLastFinalizedRequestId();
      const finalizeBlockTimestamp = BigInt((await finalizeTxReceipt!.getBlock()).timestamp);
      const finalizeLogs = parseLogs(finalizeTxReceipt, [withdrawalQueue]);

      expect(lastFinalizedRequestIdAfterFinalize).to.equal(claimerRequestId);

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

      // * * * CLAIM ETH * * *
      const claimerEthBalanceBeforeClaim = await provider.getBalance(claimer.address);
      const claimTxReceipt = await withdrawalQueue.connect(claimer).claimWithdrawal(claimerRequestId).then(receipt);

      const claimerEthBalanceAfterClaim = await provider.getBalance(claimer.address);
      const claimLogs = parseLogs(claimTxReceipt, [withdrawalQueue]);

      expect(claimerEthBalanceAfterClaim).to.equal(
        claimerEthBalanceBeforeClaim + claimerClaimableEth - claimTxReceipt!.fee,
      );

      expect(claimLogs.length).to.equal(2);

      expect(claimLogs[0]?.name).to.equal("WithdrawalClaimed");
      expect(claimLogs[0]?.args.toArray()).to.deep.equal([
        claimerRequestId,
        claimer.address,
        claimer.address,
        claimerClaimableEth,
      ]);
    });
  });
});

function strip0x(hex: string) {
  return hex.slice(0, 2) === "0x" ? hex.slice(2) : hex;
}

function parseLogs(txReceipt: ContractTransactionReceipt | null, contracts: BaseContract[]) {
  return txReceipt!.logs.map((log) => {
    for (let i = 0; i < contracts.length; i++) {
      try {
        const parsedLog = contracts[i].interface.parseLog({
          ...log,
          topics: log.topics as string[],
        });

        if (!parsedLog) {
          throw new Error();
        }

        return parsedLog;
      } catch {
        const lastContract = contracts.length - 1 === i;
        if (lastContract) {
          throw new Error("Couldn't parse log with given contract ABIs");
        }
      }
    }
  });
}

function receipt(contractTransactionResponse: ContractTransactionResponse) {
  return contractTransactionResponse.wait();
}
