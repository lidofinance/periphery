import { afterEach, beforeEach } from "mocha";
import chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { ethers } from "hardhat";

import { EvmRevertFailed, InvalidEvmSnapshotResult } from "./errors";

// enable `.eventually` asserts to avoid async/await syntax
chai.use(chaiAsPromised);

// revert the state of the blockchain back to the original state after each test
let snapshotId: string;

beforeEach(async () => {
  snapshotId = await ethers.provider.send("evm_snapshot", []);

  if (typeof snapshotId !== "string") {
    throw new InvalidEvmSnapshotResult();
  }
});

afterEach(async () => {
  const reverted = await ethers.provider.send("evm_revert", [snapshotId]);

  if (!reverted) {
    throw new EvmRevertFailed();
  }
});
