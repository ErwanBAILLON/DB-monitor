import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Instance credentials are stored AES-256-GCM encrypted. The key lives in
// Vault (DBMON_ENCRYPTION_KEY, 32 bytes hex) and only reaches the pod as env.
// Blob format: v1.<iv b64url>.<ciphertext b64url>.<tag b64url>

function key(hex = process.env.DBMON_ENCRYPTION_KEY): Buffer {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("DBMON_ENCRYPTION_KEY must be 32 bytes in hex");
  return Buffer.from(hex, "hex");
}

export function encrypt(plain: string, hex?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(hex), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function decrypt(blob: string, hex?: string): string {
  const [v, iv, enc, tag] = blob.split(".");
  if (v !== "v1" || !iv || enc === undefined || !tag) throw new Error("bad secret blob");
  const d = createDecipheriv("aes-256-gcm", key(hex), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

// Password for roles created from the console: 24 chars, URL-safe, shown once.
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}
