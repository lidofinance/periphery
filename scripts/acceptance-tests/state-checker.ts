import { expect } from "chai";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { BaseContract, Contract, JsonRpcProvider } from "ethers";

type Result = string | boolean | bigint;

type ResultAndArgs = { args: [string]; result: Result };

type Checks = {
  [key: string]: Result | ResultAndArgs;
};

type OzAcl = {
  [key: string]: [string];
};

type RegularContractEntry = {
  address: string;
  name: string;
  checks: Checks;
  ozAcl?: OzAcl;
};

type ProxyContractEntry = RegularContractEntry & {
  proxyName: string;
  implementation: string;
  proxyChecks: Checks;
  implementationChecks: Checks;
};

type NetworkSection = {
  rpcUrl: string;
  contracts: {
    [key: string]: ProxyContractEntry;
  };
};

// ==== GLOBAL VARIABLES ====
let g_abiDirectory: string;
// ==========================

async function loadContract(contractName: string, address: string, provider: JsonRpcProvider) {
  const abi = JSON.parse(readFileSync(`${g_abiDirectory}/${contractName}.json`).toString());
  return new Contract(address, abi, provider) as BaseContract;
}

function isUrl(maybeUrl: string) {
  try {
    new URL(maybeUrl);
    return true;
  } catch (_) {
    return false;
  }
}

async function checkConfigEntry({ address, name, checks, ozAcl }: RegularContractEntry, provider: JsonRpcProvider) {
  const contract: BaseContract = await loadContract(name, address, provider);
  for (const [method, expectedOrObject] of Object.entries(checks)) {
    let expected: Result;
    let args: unknown[] = [];
    if (expectedOrObject instanceof Object && "args" in expectedOrObject) {
      expected = expectedOrObject.result;
      args = expectedOrObject.args;
    } else {
      expected = expectedOrObject;
    }
    const actual = await contract.getFunction(method).staticCall(...args);
    if (typeof actual === "bigint" && typeof expected === "number") {
      expected = BigInt(expected);
    }
    const argsStr = args.length ? `(${args.toString()})` : "";
    console.log(`.${method}${argsStr}: ${actual}`);
    expect(actual).to.equal(expected);
  }

  if (ozAcl) {
    for (const role in ozAcl) {
      for (const holder of ozAcl[role]) {
        const isRoleOnHolder = await contract.getFunction("hasRole").staticCall(role, holder);
        console.log(`.hasRole(${role}, ${holder}): ${isRoleOnHolder}`);
        expect(isRoleOnHolder).to.be.true;
      }
    }
  }
}

async function checkProxyOrRegularEntry(entry: ProxyContractEntry | RegularContractEntry, provider: JsonRpcProvider) {
  await checkConfigEntry(entry, provider);

  if ("proxyChecks" in entry) {
    await checkConfigEntry(
      {
        checks: entry.proxyChecks,
        name: entry.proxyName,
        address: entry.address,
      },
      provider,
    );
  }

  if ("implementationChecks" in entry) {
    await checkConfigEntry(
      {
        checks: entry.implementationChecks,
        name: entry.name,
        address: entry.implementation,
      },
      provider,
    );
  }
}

async function checkNetworkSection(section: NetworkSection) {
  const rpcUrl = isUrl(section.rpcUrl) ? section.rpcUrl : process.env[section.rpcUrl];
  const provider = new JsonRpcProvider(rpcUrl);
  for (const contractAlias in section.contracts) {
    const entry = section.contracts[contractAlias];
    console.log(`\n====== Contract: ${contractAlias} - (${entry.name}) ======`);
    await checkProxyOrRegularEntry(entry, provider);
  }
}

export async function main() {
  const [deploymentFile, abiDir] = process.argv.slice(2);
  g_abiDirectory = abiDir;

  const configContent = readFileSync(deploymentFile).toString();
  const config = parseYaml(configContent);

  console.log(`\n============================ CONFIG ============================`);
  console.log(configContent);

  console.log(`\n============================== L1 ==============================`);
  await checkNetworkSection(config.l1);

  console.log(`\n============================== L2 ==============================`);
  await checkNetworkSection(config.l2);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
