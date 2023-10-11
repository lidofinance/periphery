import { EIP721StETH, StETH, WithdrawalQueue, WstETH } from "../typechain-types";
import { protocolConfig } from "./config.mainnet";

export type ProtocolConfig = typeof protocolConfig;

export interface Contract {
  address: string;
}
export interface Proxy extends Contract {}
export interface Implementation extends Contract {}
export interface ProtocolComponent {
  proxy?: Proxy;
  implementation: Implementation;
}

export interface Protocol {
  stETH: StETH;
  withdrawalQueue: WithdrawalQueue;
  eip712StETH: EIP721StETH;
  wstETH: WstETH;
}
