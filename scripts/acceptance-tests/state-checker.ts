import { expect } from "chai";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { BaseContract, Contract, JsonRpcProvider, isAddress, getAddress } from "ethers";

const SUCCESS_MARK = "✔";
const FAILURE_MARK = "❌";

type ViewResult = string | boolean | bigint;

type ArgsAndResult = { args: [string]; result: ViewResult; mustRevert?: boolean };

type ChecksEntryValue = ViewResult | ArgsAndResult | [ArgsAndResult];

type Checks = {
  [key: string]: ChecksEntryValue;
};

type OzNonEnumerableAcl = {
  [key: string]: [string];
};

type RegularContractEntry = {
  address: string;
  name: string;
  checks: Checks;
  ozNonEnumerableAcl?: OzNonEnumerableAcl;
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

type Abi = [
  {
    name: string;
    type: string;
    stateMutability: string;
  },
];

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

function loadAbi(contractName: string) {
  return JSON.parse(readFileSync(`${g_abiDirectory}/${contractName}.json`).toString());
}

async function loadContract(contractName: string, address: string, provider: JsonRpcProvider) {
  const abi = loadAbi(contractName);
  return new Contract(address, abi, provider);
}

function isUrl(maybeUrl: string) {
  try {
    new URL(maybeUrl);
    return true;
  } catch (_) {
    return false;
  }
}

function log(arg: unknown) {
  console.log(arg);
}

function logError(arg: unknown) {
  console.error(arg);
}

async function checkConfigEntry(
  { address, name, checks, ozNonEnumerableAcl }: RegularContractEntry,
  provider: JsonRpcProvider,
) {
  // TODO: make chai keeping full addresses in the error message
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

  if (ozNonEnumerableAcl) {
    log(`=== Non-enumerable OZ Acl checks ===`);
    for (const role in ozNonEnumerableAcl) {
      for (const holder of ozNonEnumerableAcl[role]) {
        const isRoleOnHolder = await contract.getFunction("hasRole").staticCall(role, holder);
        const logHandle = new LogCommand(`.hasRole(${role}, ${holder})`);
        try {
          expect(isRoleOnHolder).to.be.true;
          logHandle.success(`${isRoleOnHolder}`);
        } catch (error) {
          logHandle.failure(`REVERTED with: ${(error as Error).message}`);
        }
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
  } else if (expectedOrObject === null) {
    log(`· ${method}: skipped`);
    return;
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
    if (typeof expected === "string" && isAddress(expected)) {
      expect(getAddress(actual)).to.equal(getAddress(expected));
    } else {
      expect(actual).to.equal(expected);
    }
    logHandle.success(actual.toString());
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
    log(`=== Proxy checks ===`);
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
    log(`=== Implementation checks ===`);
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

function getNonMutableFunctionNames(abi: Abi) {
  const result = [];
  for (const e of abi) {
    if (e.type == "function" && !["payable", "nonpayable"].includes(e.stateMutability)) {
      result.push(e.name);
    }
  }
  return result;
}

async function checkNetworkSection(section: NetworkSection) {
  const rpcUrl = isUrl(section.rpcUrl) ? section.rpcUrl : process.env[section.rpcUrl];
  const provider = new JsonRpcProvider(rpcUrl);
  for (const contractAlias in section.contracts) {
    const entry = section.contracts[contractAlias];

    const nonMutableFromAbi = getNonMutableFunctionNames(loadAbi(entry.name));
    const nonMutableFromConfig = Object.keys(entry.checks);
    const nonCovered = nonMutableFromAbi.filter((x) => !nonMutableFromConfig.includes(x));
    if (nonCovered.length) {
      logError(`Section ${contractAlias} does not cover these non-mutable function from ABI: ${nonCovered}`);
      process.exit(1);
    }

    log(`\n====== Contract: ${contractAlias} (${entry.name}, ${entry.address}) ======`);
    await checkProxyOrRegularEntry(entry, provider);
  }
}

export async function main() {
  const [deploymentFile, abiDir] = process.argv.slice(2);
  g_abiDirectory = abiDir;

  const configContent = readFileSync(deploymentFile).toString();
  const config = parseYaml(configContent);

  // log(`\n============================ CONFIG ============================`);
  // log(configContent);

  if (config.l1) {
    log(`\n============================== L1 ==============================`);
    await checkNetworkSection(config.l1);
  }

  if (config.l2) {
    log(`\n============================== L2 ==============================`);
    await checkNetworkSection(config.l2);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
