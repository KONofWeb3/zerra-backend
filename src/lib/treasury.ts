// src/lib/treasury.ts
//
// Signs and sends real USDC on Base out of Zerra's own treasury wallet. This
// is the only place in the codebase that touches a private key or moves real
// money - every other "payout" in this app is still a human manually sending
// funds and recording the result (see routes/portfolio.ts's earnings table).
//
// The signing key is never generated or handled by this codebase. It's created
// independently, outside any AI session, and only its value ever reaches here -
// via TREASURY_PRIVATE_KEY, the same way every other secret in this app
// (TIKTOK_APP_SECRET etc.) is a Render environment variable, never committed.
//
// Configuration is checked lazily (on first real use), not at import time, so
// a missing key fails the one request that needed it with a clear error
// instead of crashing the whole server on boot.

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, getContract, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Native USDC on Base, issued directly by Circle - verified against Circle's own
// docs and BaseScan. Not the same contract as the older bridged USDbC token;
// sending to the wrong one is unrecoverable, so this is pinned, not derived.
export const USDC_ADDRESS_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_DECIMALS = 6;

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export class TreasuryNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`Treasury not configured: ${missing} is not set. Withdrawals cannot be sent until it is.`);
    this.name = "TreasuryNotConfiguredError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new TreasuryNotConfiguredError(name);
  return value;
}

function getClients() {
  const rpcUrl = requireEnv("BASE_RPC_URL");
  const privateKey = requireEnv("TREASURY_PRIVATE_KEY");
  const key = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(key);

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const usdc = getContract({ address: USDC_ADDRESS_BASE, abi: ERC20_ABI, client: { public: publicClient, wallet: walletClient } });

  return { publicClient, walletClient, usdc, treasuryAddress: account.address };
}

/** Whether the treasury is set up at all — lets a route give a clean "coming soon" instead of a stack trace. */
export function isTreasuryConfigured(): boolean {
  return Boolean(process.env.BASE_RPC_URL && process.env.TREASURY_PRIVATE_KEY);
}

/** Treasury's own USDC balance, so we can refuse a withdrawal we can't actually cover. */
export async function getTreasuryBalanceUsdc(): Promise<number> {
  const { usdc, treasuryAddress } = getClients();
  const raw = await usdc.read.balanceOf([treasuryAddress]);
  return Number(formatUnits(raw, USDC_DECIMALS));
}

export interface SendResult {
  txHash: Hash;
  /** Confirmed on-chain before this resolves — never report success without waiting for a receipt. */
  confirmed: boolean;
}

/**
 * Sends `amountUsdc` USDC to `toAddress` on Base and waits for on-chain
 * confirmation. Throws on any failure - callers must not mark a withdrawal
 * "completed" unless this resolves.
 */
export async function sendUsdc(toAddress: string, amountUsdc: number): Promise<SendResult> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    throw new Error(`Invalid destination address: ${toAddress}`);
  }
  if (!(amountUsdc > 0)) {
    throw new Error(`Withdrawal amount must be positive, got ${amountUsdc}`);
  }

  const { publicClient, usdc } = getClients();
  const amount = parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const txHash = await usdc.write.transfer([toAddress as `0x${string}`, amount]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    throw new Error(`On-chain transfer reverted (tx ${txHash})`);
  }

  return { txHash, confirmed: true };
}
