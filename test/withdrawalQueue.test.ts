import { bigintToHex } from "bigint-conversion";
import { expect } from "chai";
import { ecsign } from "ethereumjs-util";
import {
  AbiCoder,
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

  context("Withdraw flows", function () {
    let allWithdrawalRequestsFinalizedSnapshotId: string;

    // signers
    let staker: HDNodeWallet;
    let stethAsSigner: JsonRpcSigner;

    // contracts
    let steth: StETH;
    let withdrawalQueue: WithdrawalQueue;

    // constant values
    const stakeAmount = parseUnits("10.0", "ether");

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

      allWithdrawalRequestsFinalizedSnapshotId = await provider.send("evm_snapshot", []);
    });

    this.afterAll(async () => {
      await provider.send("evm_revert", [initialForkStateSnapshotId]);
    });

    this.beforeEach(async () => {
      await provider.send("evm_revert", [allWithdrawalRequestsFinalizedSnapshotId]);
    });

    it("allows the staker to go through the entire flow from stake to claim", async function () {
      // * * * STAKE * * * *
      const stakerStethBalanceBeforeStake = await steth.balanceOf(staker.address);
      const stakerEthBalanceBeforeStake = await provider.getBalance(staker.address);

      const stakeTx = await steth.submit(ZeroAddress, {
        value: stakeAmount,
      });
      const stakeTxReceipt = await stakeTx.wait();

      const stakerStethBalanceAfterStake = await steth.balanceOf(staker.address);
      const stakerEthBalanceAfterStake = await provider.getBalance(staker.address);

      expect(stakeAmount - stakerStethBalanceAfterStake - stakerStethBalanceBeforeStake).to.be.lessThanOrEqual(
        STETH_BALANCE_ERROR_MARGIN,
        "Staker stETH balance after stake is updated by the amount staked within the stETH balance error margin",
      );

      expect(stakerEthBalanceAfterStake).to.be.equal(
        stakerEthBalanceBeforeStake - stakeAmount - stakeTxReceipt!.fee,
        "Staker ETH balance after stake decreases by the amount staked and the tx fee",
      );

      // * * * SUBMIT WITHDRAWAL REQUEST * * *

      // give withdrawal queue allowance
      const allowanceBeforeApprove = await steth.allowance(staker.address, withdrawalQueueAddress);
      const approveTx = await steth.approve(withdrawalQueueAddress, stakeAmount);
      const approveTxReceipt = await approveTx.wait();
      const allowanceAfterApprove = await steth.allowance(staker.address, withdrawalQueueAddress);
      const stakerEthBalanceAfterApprove = await provider.getBalance(staker.address);
      expect(allowanceAfterApprove).to.equal(
        allowanceBeforeApprove + stakeAmount,
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
      const withdrawalRequests = [stakeAmount];
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

      // finalize request
      const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
      const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
      const { ethToLock: stakerClaimableEth } = await withdrawalQueue.prefinalize([stakerRequestId], currentShareRate);
      await withdrawalQueue.connect(stethAsSigner).finalize(stakerRequestId, currentShareRate);
      const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
      expect(lastFinalizedRequestId).to.equal(stakerRequestId, "Last finalized request is that of the staker's");

      // claim eth
      const claimTx = await withdrawalQueue.claimWithdrawal(stakerRequestId, { from: staker.address });
      const claimTxReceipt = await claimTx.wait();
      const stakerEthBalanceAfterClaim = await provider.getBalance(staker.address);
      expect(stakerEthBalanceAfterClaim).to.equal(
        stakerEthBalanceAfterRequest + stakerClaimableEth - claimTxReceipt!.fee,
        "Staker eth balance after claim increased by the amount of eth owed according to the finalization share rate with the claim fee deducted",
      );
    });

    it("allows claiming eth from another account via permit", async function () {
      // * * * STAKE * * * *
      const stakerStethBalanceBeforeStake = await steth.balanceOf(staker.address);
      const stakerEthBalanceBeforeStake = await provider.getBalance(staker.address);

      const stakeTx = await steth.submit(ZeroAddress, {
        value: stakeAmount,
      });
      const stakeTxReceipt = await stakeTx.wait();

      const stakerStethBalanceAfterStake = await steth.balanceOf(staker.address);
      const stakerEthBalanceAfterStake = await provider.getBalance(staker.address);

      expect(stakeAmount - stakerStethBalanceAfterStake - stakerStethBalanceBeforeStake).to.be.lessThanOrEqual(
        STETH_BALANCE_ERROR_MARGIN,
        "Staker stETH balance after stake is updated by the amount staked within the stETH balance error margin",
      );

      expect(stakerEthBalanceAfterStake).to.be.equal(
        stakerEthBalanceBeforeStake - stakeAmount - stakeTxReceipt!.fee,
        "Staker ETH balance after stake decreases by the amount staked and the tx fee",
      );

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
      const requestTx = await withdrawalQueue.requestWithdrawalsWithPermit(withdrawalRequests, claimer.address, permit);
      const requestTxReceipt = await requestTx.wait();
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

      // finalize request
      const [totalPooledEther, totalShares] = await Promise.all([steth.getTotalPooledEther(), steth.getTotalShares()]);
      const currentShareRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
      const { ethToLock: claimerClaimableEth } = await withdrawalQueue.prefinalize(
        [claimerRequestId],
        currentShareRate,
      );
      await withdrawalQueue.connect(stethAsSigner).finalize(claimerRequestId, currentShareRate);
      const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
      expect(lastFinalizedRequestId).to.equal(claimerRequestId, "Last finalized request is that of the claimer's");

      // claim eth
      const claimerEthBalanceBeforeClaim = await provider.getBalance(claimer.address);
      const claimTx = await withdrawalQueue.connect(claimer).claimWithdrawal(claimerRequestId);
      const claimTxReceipt = await claimTx.wait();
      const claimerEthBalanceAfterClaim = await provider.getBalance(claimer.address);
      expect(claimerEthBalanceAfterClaim).to.equal(
        claimerEthBalanceBeforeClaim + claimerClaimableEth - claimTxReceipt!.fee,
        "Claimer eth balance after claim increased by the amount of eth owed according to the finalization share rate with the claim fee deducted",
      );
    });
  });
});

function strip0x(hex: string) {
  return hex.slice(0, 2) === "0x" ? hex.slice(2) : hex;
}
