import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const DEFAULT_NODE_URL = "http://127.0.0.1:8545";

const config: HardhatUserConfig = {
  defaultNetwork: "localhost",
  networks: {
    hardhat: {
      from: DEFAULT_NODE_URL,
    },
    "mainnet-fork": {
      url: DEFAULT_NODE_URL,
      forking: {
        url: `https://mainnet.infura.io/v3/${process.env.WEB3_INFURA_PROJECT_ID}`,
      },
      loggingEnabled: true,
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.4.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "constantinople",
        },
      },
      {
        version: "0.6.11",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
      {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
      {
        version: "0.8.9",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
    ],
  },
};

export default config;

task("code", "Log the bytecode associated with the specified address")
  .addPositionalParam("address")
  .setAction(async ({ address }, hre) => {
    const code = await hre.ethers.provider.getCode(address);
    console.log(code);
  });
