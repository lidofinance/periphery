import { ethers } from "hardhat";
import { WithdrawalQueue, WithdrawalQueue__factory } from "../../typechain-types";
import { protocolConfig } from "./config.mainnet";
import { ProtocolConfig } from "./types";

export class Protocol {
  public readonly config: ProtocolConfig;
  public readonly withdrawalQueue: WithdrawalQueue;

  constructor(config: ProtocolConfig) {
    this.config = config;
    this.withdrawalQueue = WithdrawalQueue__factory.connect(
      config.withdrawalQueue.implementation.address,
      ethers.provider,
    );
  }
}

export const protocol = new Protocol(protocolConfig);
