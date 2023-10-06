import { ProtocolConfig } from "./types";

export const protocolConfig: ProtocolConfig = {
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
};
