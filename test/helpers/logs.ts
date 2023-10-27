import { BaseContract, ContractTransactionReceipt } from "ethers";

export function parseLogs(txReceipt: ContractTransactionReceipt | null, contracts: BaseContract[]) {
  return txReceipt!.logs.map((log) => {
    for (let i = 0; i < contracts.length; i++) {
      try {
        const parsedLog = contracts[i].interface.parseLog({
          ...log,
          topics: log.topics as string[],
        });

        if (!parsedLog) {
          throw new Error();
        }

        return parsedLog;
      } catch {
        const lastContract = contracts.length - 1 === i;
        if (lastContract) {
          throw new Error("Couldn't parse log with given contract ABIs");
        }
      }
    }
  });
}
