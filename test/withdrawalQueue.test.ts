import { expect } from "chai";
import describeContract from "./describe";

describeContract("WithdrawalQueue", (protocol) => {
  it("should return correct stETH address", async () => {
    const stETHAddress = await protocol.withdrawalQueue.STETH();
    expect(stETHAddress).to.equal(protocol.config.stETH.proxy.address);
  });
});
