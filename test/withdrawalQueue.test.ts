import { assert, expect } from "chai";
import { JsonRpcProvider, ZeroAddress, parseUnits } from "ethers";
import { StETH__factory, WithdrawalQueue__factory } from "../typechain-types";
import { protocolConfig } from "./setup/config.mainnet";

const STETH_BALANCE_ERROR_MARGIN = 2n;
const PRECISION_FACTOR = 10n ** 27n;

describe("WithdrawalQueue", function () {
  it("allows the staker to go through the entire flow from stake to claim", async function () {
    // setup
    const provider = new JsonRpcProvider("http://127.0.0.1:8545");

    const {
      stETH: {
        proxy: { address: stethAddress },
      },
      withdrawalQueue: {
        proxy: { address: withdrawalQueueAddress },
      },
    } = protocolConfig;

    const staker = await provider.getSigner();
    const stake = parseUnits("10.0", "ether");

    // stake
    const steth = StETH__factory.connect(stethAddress, staker);
    const initialStakerStethBalance = await steth.balanceOf(staker.address);
    await steth.submit(ZeroAddress, {
      value: stake,
    });
    const stakerStethBalanceAfterStake = await steth.balanceOf(staker.address);
    assert(
      initialStakerStethBalance + stake - stakerStethBalanceAfterStake <= STETH_BALANCE_ERROR_MARGIN,
      "Staker got precisely the staked amount of stETH or within the stETH error margin",
    );

    // submit withdrawal request
    const withdrawalQueue = WithdrawalQueue__factory.connect(withdrawalQueueAddress, staker);
    await steth.approve(withdrawalQueueAddress, stake);

    const withdrawalRequests = [stake];
    await withdrawalQueue.requestWithdrawals(withdrawalRequests, staker.address);
    const lastRequestId = await withdrawalQueue.getLastRequestId();
    const stakerRequestIds = await withdrawalQueue.getWithdrawalRequests(staker.address);
    const stakerRequestId = stakerRequestIds[0];
    expect(stakerRequestIds.length).to.equal(
      withdrawalRequests.length,
      "Only 1 withdrawal request submitted by the staker",
    );
    expect(lastRequestId).to.equal(stakerRequestId, "Last request id matches the staker's request id");

    // top up Lido buffer to finalize queued requests
    const ethWhaleAddress = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // deposit contract 😏
    await provider.send("anvil_impersonateAccount", [ethWhaleAddress]);
    const ethWhale = await provider.getSigner(ethWhaleAddress);
    await ethWhale.sendTransaction({
      to: stethAddress,
      value: parseUnits("100000.0", "ether"),
    });

    // finalize requests
    await provider.send("anvil_impersonateAccount", [stethAddress]);
    const stethAsSigner = await provider.getSigner(stethAddress);

    // for some reason ethers throws an exception when tx.from != contract.signer,
    // so we have instantiate WQ with steth as signer
    const withdrawalQueueFromSteth = WithdrawalQueue__factory.connect(withdrawalQueueAddress, stethAsSigner);

    const totalPooledEther = await steth.getTotalPooledEther();
    const totalShares = await steth.getTotalShares();
    const currentRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
    const batch = await withdrawalQueueFromSteth.prefinalize([stakerRequestId], currentRate);
    await withdrawalQueueFromSteth.finalize(stakerRequestId, currentRate.toString(10), {
      value: batch.ethToLock,
    });
    const currentFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    assert(stakerRequestId === currentFinalizedRequestId);

    // claim eth
    const previousStakerEthBalanace = await provider.getBalance(staker.address);
    const tx = await withdrawalQueue.claimWithdrawal(stakerRequestId, { from: staker.address });
    await tx.wait();
    const currentStakerEthBalanace = await provider.getBalance(staker.address);
    expect(currentStakerEthBalanace).to.equal(previousStakerEthBalanace + stake);
  });
});
