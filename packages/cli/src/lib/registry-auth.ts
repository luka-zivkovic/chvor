import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { getChvorHome } from "./paths.js";

interface StoredAuth {
  token: string;
  username: string;
  registryUrl: string;
  expiresAt: string;
}

function getAuthPath(): string {
  return join(getChvorHome(), "data", "registry-auth.json");
}

function readAuth(): StoredAuth | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf8")) as StoredAuth;
    // Check expiry
    if (new Date(data.expiresAt) < new Date()) return null;
    return data;
  } catch {
    return null;
  }
}

function writeAuth(auth: StoredAuth): void {
  const authPath = getAuthPath();
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function getRegistryToken(registryUrl: string): string | null {
  const auth = readAuth();
  if (!auth) return null;
  if (auth.registryUrl !== registryUrl) return null;
  return auth.token;
}

export function isAuthenticated(registryUrl: string): boolean {
  return getRegistryToken(registryUrl) !== null;
}

export function getUsername(registryUrl: string): string | null {
  const auth = readAuth();
  if (!auth || auth.registryUrl !== registryUrl) return null;
  return auth.username;
}

export function logout(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    writeFileSync(authPath, "{}", "utf8");
  }
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
    execFile(cmd, [url], () => {});
  } catch {
    // Non-critical — user can open manually
  }
}

/**
 * Authenticate with the registry using GitHub device flow.
 * Opens the user's browser to GitHub where they enter a code.
 */
export async function authenticate(registryUrl: string): Promise<{ token: string; username: string }> {
  // Step 1: Initiate device flow
  console.log("Authenticating with the registry...\n");

  const codeRes = await fetch(`${registryUrl}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!codeRes.ok) {
    const body = await codeRes.text();
    throw new Error(`Failed to initiate authentication: ${body}`);
  }

  const codeData = await codeRes.json() as {
    user_code: string;
    verification_uri: string;
    device_code: string;
    expires_in: number;
    interval: number;
  };

  // Step 2: Display instructions to user
  console.log("To authenticate, visit:");
  console.log(`\n  ${codeData.verification_uri}\n`);
  console.log(`Enter code: ${codeData.user_code}\n`);
  console.log("Waiting for authorization...");

  // Try to open browser
  openBrowser(codeData.verification_uri);

  // Step 3: Poll for token
  let interval = (codeData.interval || 5) * 1000;
  const deadline = Date.now() + (codeData.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    const tokenRes = await fetch(`${registryUrl}/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: codeData.device_code }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: HTTP ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json() as {
      status: "pending" | "slow_down" | "expired" | "complete";
      token?: string;
      username?: string;
      interval?: number;
    };

    switch (tokenData.status) {
      case "complete": {
        if (!tokenData.token || !tokenData.username) {
          throw new Error("Received complete status but missing token/username");
        }

        // Store auth
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        writeAuth({
          token: tokenData.token,
          username: tokenData.username,
          registryUrl,
          expiresAt,
        });

        console.log(`\nAuthenticated as ${tokenData.username}`);
        return { token: tokenData.token, username: tokenData.username };
      }

      case "slow_down":
        if (tokenData.interval) interval = tokenData.interval * 1000;
        else interval += 5000;
        break;

      case "expired":
        throw new Error("Device code expired. Please try again.");

      case "pending":
        // Keep polling
        break;

      default:
        throw new Error(`Unexpected status: ${tokenData.status}`);
    }
  }

  throw new Error("Authentication timed out. Please try again.");
}
