import { lookup } from "node:dns/promises";
import { getAllowLocalhost } from "../../db/config-store.ts";
import { isPrivateIp } from "../url-safety.ts";

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

export async function validateFetchUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  const { address } = await lookup(parsed.hostname);
  if (!getAllowLocalhost() && isPrivateIp(address)) {
    throw new Error(`Blocked private/internal address: ${parsed.hostname}. Enable "Allow localhost" in Settings → Permissions to access local services.`);
  }
  return parsed;
}

export function sanitizeYamlValue(val: string): string {
  return `"${val.replace(/[\n\r]/g, " ").replace(/"/g, '\\"')}"`;
}
