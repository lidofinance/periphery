import { expect } from "chai";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { BaseContract, Contract, JsonRpcProvider } from "ethers";
import { isAddress } from "ethers";

const SUCCESS_MARK = "✔";
const FAILURE_MARK = "❌";

type ViewResult = string | boolean | bigint;

type ArgsAndResult = { args: [string]; result: ViewResult; mustRevert?: boolean };

type ChecksEntryValue = ViewResult | ArgsAndResult | [ArgsAndResult];

type Checks = {
  [key: string]: ChecksEntryValue;
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

class LogCommand {
  private description: string;

  constructor(description: string) {
    this.description = description;
    this.initialPrint();
  }

  private initialPrint(): void {
    const indent = "  "; // SUCCESS_MARK printed length
    process.stdout.write(`${indent}${this.description}: ...`);
  }

  public printResult(success: boolean, result: string): void {
    const statusSymbol = success ? SUCCESS_MARK : FAILURE_MARK;
    process.stdout.cursorTo(0);
    process.stdout.clearLine(0);
    process.stdout.write(`${statusSymbol} ${this.description}: ${result}\n`);
  }

  public success(result: string): void {
    this.printResult(true, result);
  }

  public failure(result: string): void {
    this.printResult(false, result);
  }
}

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
  expect(isAddress(address), `${address} is invalid address`).to.be.true;
  const contract: BaseContract = await loadContract(name, address, provider);
  for (const [method, checkEntryValue] of Object.entries(checks)) {
    if (checkEntryValue instanceof Array) {
      for (const viewResultOrObject of checkEntryValue) {
        await checkViewFunction(contract, method, viewResultOrObject);
      }
    } else {
      await checkViewFunction(contract, method, checkEntryValue);
    }
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

async function checkViewFunction(contract: BaseContract, method: string, expectedOrObject: ChecksEntryValue) {
  let expected: ViewResult;
  let args: unknown[] = [];
  let mustRevert: boolean = false;
  if (expectedOrObject instanceof Object && "args" in expectedOrObject) {
    expected = expectedOrObject.result;
    args = expectedOrObject.args;
    mustRevert = expectedOrObject.mustRevert || false;
  } else {
    expected = expectedOrObject as ViewResult;
  }

  const argsStr = args.length ? `(${args.toString()})` : "";
  const logHandle = new LogCommand(`.${method}${argsStr}`);

  let actual = undefined;
  try {
    actual = await contract.getFunction(method).staticCall(...args);
    if (typeof actual === "bigint" && typeof expected === "number") {
      expected = BigInt(expected);
    }
    logHandle.success(actual.toString());
    expect(actual).to.equal(expected);
  } catch (error) {
    if (mustRevert) {
      logHandle.success(`REVERTED with: ${(error as Error).message}`);
    } else {
      logHandle.failure(`REVERTED with: ${(error as Error).message}`);
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
    console.log(`\n====== Contract: ${contractAlias} (${entry.name}) ======`);
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

  if (config.l1) {
    console.log(`\n============================== L1 ==============================`);
    await checkNetworkSection(config.l1);
  }

  if (config.l2) {
    console.log(`\n============================== L2 ==============================`);
    await checkNetworkSection(config.l2);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
