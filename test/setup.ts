import { ethers } from "hardhat";
import { afterEach, beforeEach } from "mocha";
import { EvmRevertFailed, InvalidEvmSnapshotResult } from "./errors";

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
