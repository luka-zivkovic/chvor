import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHVOR_DATA_DIR ?? resolve(__dirname, "../../data");

const ALGORITHM = "aes-256-gcm";
const KEY_PATH = join(DATA_DIR, ".encryption-key");

function loadOrCreateKey(): Buffer {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(KEY_PATH)) {
    return Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "hex");
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString("hex"), { mode: 0o600 });
  console.log("[crypto] generated new encryption key");
  return key;
}

let _key: Buffer | null = null;
function getKey(): Buffer {
  if (!_key) _key = loadOrCreateKey();
  return _key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: iv(24 hex) + tag(32 hex) + ciphertext(hex)
  return iv.toString("hex") + tag.toString("hex") + encrypted.toString("hex");
}

export function decrypt(encoded: string): string {
  const iv = Buffer.from(encoded.slice(0, 24), "hex");
  const tag = Buffer.from(encoded.slice(24, 56), "hex");
  const ciphertext = Buffer.from(encoded.slice(56), "hex");
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}
