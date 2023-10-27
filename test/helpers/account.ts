import { JsonRpcProvider, JsonRpcSigner } from "ethers";

export async function impersonate(address: string, provider: JsonRpcProvider): Promise<JsonRpcSigner> {
  await provider.send("anvil_impersonateAccount", [address]);
  return new JsonRpcSigner(provider, address);
}
