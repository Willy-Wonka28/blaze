import { createWalletClient, http, type WalletClient } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../../config.js";
import { encrypt, decrypt } from "./aes.js";
import { getUserByChatId, updateUserByChatId, type BlazeUser } from "../supabase.js";
import { log } from "../../logger.js";

const CLOB_HOST = config.polymarket.baseUrl;
const CHAIN_ID = 137;
const CLOB_AUTH_DOMAIN = { name: "ClobAuthDomain", version: "1", chainId: CHAIN_ID };
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;
const ATTESTATION_MESSAGE = "This message attests that I control the given wallet";

interface DerivedCreds {
  key: string;
  secret: string;
  passphrase: string;
}

interface WarmCreds {
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

// Pre-warmed credential cache — populated at init, read on every trade.
// Avoids 4x decrypt() calls per trade per user.
const warmCredsCache = new Map<number, WarmCreds>();

export function setWarmCreds(chatId: number, creds: WarmCreds): void {
  warmCredsCache.set(chatId, creds);
}

export function getWarmCreds(chatId: number): WarmCreds | undefined {
  return warmCredsCache.get(chatId);
}

export function clearWarmCreds(chatId: number): void {
  warmCredsCache.delete(chatId);
}

function makeWalletClient(privateKey: string): WalletClient & { account: ReturnType<typeof privateKeyToAccount> } {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({ account, chain: polygon, transport: http() }) as WalletClient & { account: ReturnType<typeof privateKeyToAccount> };
}

async function buildL1Headers(walletClient: WalletClient & { account: ReturnType<typeof privateKeyToAccount> }, nonce = 0): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const address = walletClient.account.address;

  const signature = await walletClient.signTypedData({
    account: walletClient.account,
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address,
      timestamp: `${ts}`,
      nonce: BigInt(nonce),
      message: ATTESTATION_MESSAGE,
    },
  });

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: `${ts}`,
    POLY_NONCE: `${nonce}`,
  };
}

async function createApiKey(walletClient: WalletClient & { account: ReturnType<typeof privateKeyToAccount> }): Promise<DerivedCreds> {
  const headers = await buildL1Headers(walletClient);
  const res = await fetch(`${CLOB_HOST}/auth/api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
  });

  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`POST /auth/api-key failed (${res.status}): ${JSON.stringify(body)}`);
  }

  const creds = { key: body.apiKey, secret: body.secret, passphrase: body.passphrase };
  if (!creds.key || !creds.secret || !creds.passphrase) {
    throw new Error(`POST /auth/api-key returned incomplete creds: ${JSON.stringify(body)}`);
  }
  return creds;
}

async function deriveApiKey(walletClient: WalletClient & { account: ReturnType<typeof privateKeyToAccount> }, nonce = 0): Promise<DerivedCreds> {
  const headers = await buildL1Headers(walletClient, nonce);
  const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: "GET",
    headers,
  });

  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`GET /auth/derive-api-key failed (${res.status}): ${JSON.stringify(body)}`);
  }

  const creds = { key: body.apiKey, secret: body.secret, passphrase: body.passphrase };
  if (!creds.key || !creds.secret || !creds.passphrase) {
    throw new Error(`GET /auth/derive-api-key returned incomplete creds: ${JSON.stringify(body)}`);
  }
  return creds;
}

async function createOrDeriveApiKey(walletClient: WalletClient & { account: ReturnType<typeof privateKeyToAccount> }): Promise<DerivedCreds> {
  try {
    return await createApiKey(walletClient);
  } catch (createErr) {
    log("Blaze", `createApiKey failed, trying deriveApiKey: ${createErr}`);
    return await deriveApiKey(walletClient);
  }
}

export async function deriveAndStoreCredentials(chatId: number): Promise<void> {
  const user = await getUserByChatId(chatId);
  if (!user?.encrypted_private_key) return;

  if (user.encrypted_api_key && user.encrypted_api_secret && user.encrypted_passphrase) {
    return;
  }

  const privateKey = config.blaze.backendSecret
    ? await decrypt(user.encrypted_private_key)
    : user.encrypted_private_key;

  const walletClient = makeWalletClient(privateKey);
  const creds = await createOrDeriveApiKey(walletClient);

  const [encKey, encSecret, encPassphrase] = await Promise.all([
    encrypt(creds.key),
    encrypt(creds.secret),
    encrypt(creds.passphrase),
  ]);

  await updateUserByChatId(chatId, {
    encrypted_api_key: encKey,
    encrypted_api_secret: encSecret,
    encrypted_passphrase: encPassphrase,
    funder_address: walletClient.account.address,
  });

  log("Blaze", `Derived Polymarket credentials for chat ${chatId}`);
}

export async function getUserCreds(user: BlazeUser): Promise<DerivedCreds | null> {
  if (!user.encrypted_api_key || !user.encrypted_api_secret || !user.encrypted_passphrase) {
    return null;
  }

  if (!config.blaze.backendSecret) return null;

  const [key, secret, passphrase] = await Promise.all([
    decrypt(user.encrypted_api_key),
    decrypt(user.encrypted_api_secret),
    decrypt(user.encrypted_passphrase),
  ]);

  return { key, secret, passphrase };
}
