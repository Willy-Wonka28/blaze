import { config } from "../../config.js";

const ALGO = "AES-GCM";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function getKey(): Uint8Array {
  const secret = config.blaze.backendSecret;
  if (!secret) throw new Error("BACKEND_SECRET not configured — cannot encrypt/decrypt");
  const keyBytes = Buffer.from(secret, "hex");
  if (keyBytes.length !== KEY_LENGTH) {
    throw new Error(`BACKEND_SECRET must be ${KEY_LENGTH * 2} hex characters (got ${keyBytes.length * 2})`);
  }
  return new Uint8Array(keyBytes);
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const cryptoKey = await crypto.subtle.importKey("raw", key, ALGO, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, cryptoKey, encoded);

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

export async function decrypt(encoded: string): Promise<string> {
  const key = getKey();
  const combined = new Uint8Array(Buffer.from(encoded, "base64"));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const cryptoKey = await crypto.subtle.importKey("raw", key, ALGO, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, cryptoKey, ciphertext);

  return new TextDecoder().decode(decrypted);
}
