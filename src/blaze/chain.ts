// On-chain operations: balance checks and USDC approve for Polymarket V2.
// Wallets need pUSD approval to the Exchange contracts before blaze can trade.

import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

const PUSD_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const publicClient = createPublicClient({
  chain: polygon,
  transport: http(config.blockchain.rpcUrl),
});

function signerWallet(privateKey: string) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({ account, chain: polygon, transport: http(config.blockchain.rpcUrl) });
}

export interface Balances {
  pusd: string;    // formatted USDC balance
  pol: string;     // formatted POL balance
}

export async function getBalances(address: string): Promise<Balances> {
  const [pusdRaw, polRaw] = await Promise.all([
    publicClient.readContract({
      address: config.polymarket.collateral,
      abi: PUSD_ABI,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    }),
    publicClient.getBalance({ address: address as `0x${string}` }),
  ]);

  return {
    pusd: formatUnits(pusdRaw, 6),
    pol: formatUnits(polRaw, 18),
  };
}

export async function approveExchanges(privateKey: string): Promise<{ exchange: string; negRisk: string }> {
  const wallet = signerWallet(privateKey);
  const maxUint = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

  const [exchangeTx, negRiskTx] = await Promise.all([
    wallet.writeContract({
      address: config.polymarket.collateral,
      abi: PUSD_ABI,
      functionName: "approve",
      args: [config.polymarket.exchangeV3, maxUint],
    }),
    wallet.writeContract({
      address: config.polymarket.collateral,
      abi: PUSD_ABI,
      functionName: "approve",
      args: [config.polymarket.negRiskExchangeV2, maxUint],
    }),
  ]);

  return { exchange: exchangeTx, negRisk: negRiskTx };
}

export async function checkAllowance(address: string, spender: `0x${string}`): Promise<string> {
  const raw = await publicClient.readContract({
    address: config.polymarket.collateral,
    abi: PUSD_ABI,
    functionName: "allowance",
    args: [address as `0x${string}`, spender],
  });
  return formatUnits(raw, 6);
}
