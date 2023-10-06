export interface ProtocolConfig {
  stETH: ProtocolComponent;
  withdrawalQueue: ProtocolComponent;
}

export interface Contract {
  address: string;
}
export interface Proxy extends Contract {}
export interface Implementation extends Contract {}
export interface ProtocolComponent {
  proxy: Proxy;
  implementation: Implementation;
}
