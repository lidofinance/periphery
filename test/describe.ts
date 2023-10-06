import { Protocol, protocol } from "./protocol";

export default function describeContract(contractName: string, descriptor: (protocol: Protocol) => void): void {
  describe(contractName, () => {
    descriptor(protocol);
  });
}
