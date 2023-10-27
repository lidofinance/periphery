export const protocolConfig = Object.freeze({
  eip712StETH: {
    implementation: {
      address: "0x8F73e4C2A6D852bb4ab2A45E6a9CF5715b3228B7",
    },
  },
  stETH: {
    proxy: {
      address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    },
    implementation: {
      address: "0x17144556fd3424EDC8Fc8A4C940B2D04936d17eb",
    },
  },
  withdrawalQueue: {
    proxy: {
      address: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
    },
    implementation: {
      address: "0xE42C659Dc09109566720EA8b2De186c2Be7D94D9",
    },
  },
  wstETH: {
    implementation: {
      address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    },
  },
  depositSecurityModule: {
    implementation: {
      address: "0xC77F8768774E1c9244BEed705C4354f2113CFc09",
    },
  },
} as const);
