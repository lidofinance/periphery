import { assert, expect } from "chai";
import { ecsign } from "ethereumjs-util";
import { bigintToHex } from "bigint-conversion";
import { StETH__factory, WithdrawalQueue__factory } from "../typechain-types";
import { AbiCoder, JsonRpcProvider, Wallet, ZeroAddress, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { protocolConfig } from "./setup/config.mainnet";

const STETH_BALANCE_ERROR_MARGIN = 2n;
const MAX_UINT256 = 2n ** 256n - 1n;
const PRECISION_FACTOR = 10n ** 27n;

describe("WithdrawalQueue", function () {
  xit("allows to withdraw via permit from another account", async function () {
    // set up provider
    const provider = new JsonRpcProvider("http://127.0.0.1:8545");

    // create a new account for staker
    const staker = Wallet.createRandom(provider);

    // top up staker account
    const stake = parseUnits("10.0", "ether");

    const sponsor = await provider.getSigner();
    await sponsor.sendTransaction({
      to: staker.address,
      value: parseUnits("11.0", "ether"),
    });

    // stake
    const steth = StETH__factory.connect(protocolConfig.stETH.proxy.address, staker);
    const initialStakerStethBalance = await steth.balanceOf(staker.address);
    await steth.submit(ZeroAddress, {
      value: stake,
    });
    const stakerStethBalanceAfterStake = await steth.balanceOf(staker.address);
    assert(
      stakerStethBalanceAfterStake - stake <= STETH_BALANCE_ERROR_MARGIN,
      "Staker's updated stETH balance is within the stETH error margin",
    );

    // get permit
    const withdrawalQueueAddress = protocolConfig.withdrawalQueue.proxy.address;
    const stethDomainSeparator = await steth.DOMAIN_SEPARATOR();
    const permitType = keccak256(
      toUtf8Bytes("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
    );
    const stakeInHex = bigintToHex(stake, true);
    const nonceInHex = bigintToHex(0n, true);
    const deadlineInHex = bigintToHex(MAX_UINT256, true);
    const encodedParameters = keccak256(
      new AbiCoder().encode(
        ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
        [permitType, staker.address, withdrawalQueueAddress, stakeInHex, nonceInHex, deadlineInHex],
      ),
    );
    const message = keccak256("0x1901" + strip0x(stethDomainSeparator) + strip0x(encodedParameters));
    const { v, r, s } = ecsign(Buffer.from(strip0x(message), "hex"), Buffer.from(strip0x(staker.privateKey), "hex"));
    const permit = {
      value: stake,
      deadline: deadlineInHex,
      v,
      r,
      s,
    };

    // submit withdrawal request
    const withdrawalClaimer = await provider.getSigner();
    const withdrawalQueue = WithdrawalQueue__factory.connect(withdrawalQueueAddress, staker);

    const lastRequestIdBefore = await withdrawalQueue.getLastRequestId();
    const withdrawalRequests = [stake];
    await withdrawalQueue.requestWithdrawalsWithPermit(withdrawalRequests, withdrawalClaimer.address, permit);
    const lastRequestIdAfter = await withdrawalQueue.getLastRequestId();
    const stakerStethBalanceAfterRequest = await steth.balanceOf(staker.address);

    assert(lastRequestIdBefore + BigInt(withdrawalRequests.length) === lastRequestIdAfter);
    assert(stakerStethBalanceAfterRequest == initialStakerStethBalance);

    await provider.send("anvil_impersonateAccount", [protocolConfig.stETH.proxy.address]);
    const stethImpersonated = await provider.getSigner(protocolConfig.stETH.proxy.address);

    const withdrawalQueueFromSteth = WithdrawalQueue__factory.connect(
      protocolConfig.withdrawalQueue.proxy.address,
      stethImpersonated,
    );

    // finalize request
    const totalPooledEther = await steth.getTotalPooledEther();
    const totalShares = await steth.getTotalShares();
    const currentRate = (totalPooledEther * PRECISION_FACTOR) / totalShares;
    await withdrawalQueueFromSteth.finalize(lastRequestIdAfter, currentRate.toString(10), {
      from: stethImpersonated,
      value: stake,
    });

    // claim eth
    const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    assert(lastFinalizedRequestId == lastRequestIdAfter);

    const withdrawalQueueFromClaimer = WithdrawalQueue__factory.connect(withdrawalQueueAddress, withdrawalClaimer);

    const claimerEthBalanceBeforeClaim = await provider.getBalance(withdrawalClaimer.address);
    await withdrawalQueueFromClaimer.claimWithdrawal(lastFinalizedRequestId);
    const claimerEthBalanceAfterClaim = await provider.getBalance(withdrawalClaimer.address);
    expect(claimerEthBalanceAfterClaim).to.equal(claimerEthBalanceBeforeClaim);
  });
});

function strip0x(hex: string) {
  return hex.slice(0, 2) === "0x" ? hex.slice(2) : hex;
}
