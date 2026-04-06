import type {
  CredentialType,
  CredentialData,
  TestCredentialResponse,
} from "@chvor/shared";
import { assertSafeUrl, isLocalUrl } from "../lib/url-safety.ts";

export async function testProvider(
  type: CredentialType,
  data: CredentialData
): Promise<TestCredentialResponse> {
  try {
    switch (type) {
      case "anthropic":
        return await testAnthropic(data.apiKey);
      case "openai":
        return await testOpenAI(data.apiKey);
      case "deepseek":
        return await testDeepSeek(data.apiKey);
      case "minimax":
        return await testMiniMax(data.apiKey);
      case "openrouter":
        return await testOpenRouter(data.apiKey);
      case "voyageai":
        return await testVoyageAI(data.apiKey);
      case "cohere":
        return await testCohere(data.apiKey);
      case "google-ai":
        return await testGoogleAI(data.apiKey);
      case "groq":
        return await testGroq(data.apiKey);
      case "mistral":
        return await testMistral(data.apiKey);
      case "ollama":
        return await testOllama(data.baseUrl ?? "http://localhost:11434/v1");
      case "lmstudio":
        return await testLMStudio(data.baseUrl ?? "http://localhost:1234/v1");
      case "vllm":
        return await testVLLM(data.baseUrl ?? "http://localhost:8000/v1", data.apiKey);
      case "ollama-cloud":
        return await testOllamaCloud(data.apiKey);
      case "github":
        return await testGitHub(data.apiKey);
      case "notion":
        return await testNotion(data.apiKey);
      case "elevenlabs":
        return await testElevenLabs(data.apiKey);
      case "custom-llm":
        return await testCustomLLM(data.baseUrl, data.apiKey);
      case "telegram":
        return await testTelegram(data.botToken);
      case "discord":
        return await testDiscord(data.botToken);
      case "slack":
        return await testSlack(data.botToken, data.appToken);
      case "whatsapp":
        return testWhatsApp();
      case "matrix":
        return await testMatrix(data.homeserverUrl, data.accessToken);
      case "obsidian":
        return await testObsidian(data.vaultPath);
      case "gitlab":
        return await testGitLab(data.instanceUrl, data.token);
      case "jira":
        return await testJira(data.domain, data.email, data.apiToken);
      case "homeassistant":
        return await testHomeAssistant(data.instanceUrl, data.token);
      default:
        return { success: false, error: `No test available for credential type: ${type}` };
    }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testElevenLabs(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.detail?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testCustomLLM(baseUrl: string, apiKey: string): Promise<TestCredentialResponse> {
  if (!baseUrl) return { success: false, error: "Base URL is required" };

  try {
    assertSafeUrl(baseUrl, "Custom LLM baseUrl");

    const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    const url = new URL("models", base).toString();
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testAnthropic(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return {
      success: false,
      error: body?.error?.message ?? `HTTP ${res.status}`,
    };
  }
  return { success: true };
}

async function testTelegram(botToken: string): Promise<TestCredentialResponse> {
  if (!botToken) return { success: false, error: "Bot token is required" };

  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.json().catch(() => ({})) as {
    ok?: boolean;
    description?: string;
    result?: { username: string };
  };

  if (!body.ok) {
    return { success: false, error: body.description ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testDiscord(botToken: string): Promise<TestCredentialResponse> {
  if (!botToken) return { success: false, error: "Bot token is required" };

  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return {
      success: false,
      error: body?.message ?? `HTTP ${res.status}`,
    };
  }
  return { success: true };
}

async function testSlack(botToken: string, appToken: string): Promise<TestCredentialResponse> {
  if (!botToken) return { success: false, error: "Bot token is required" };
  if (!appToken) return { success: false, error: "App-level token (xapp-) is required" };

  // Test bot token
  const botRes = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  const botBody = await botRes.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
  };

  if (!botBody.ok) {
    return { success: false, error: `Bot token: ${botBody.error ?? `HTTP ${botRes.status}`}` };
  }

  // Test app-level token via Socket Mode handshake
  const appRes = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  const appBody = await appRes.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
  };

  if (!appBody.ok) {
    return { success: false, error: `App token: ${appBody.error ?? `HTTP ${appRes.status}`}` };
  }

  return { success: true };
}

async function testOpenAI(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return {
      success: false,
      error: body?.error?.message ?? `HTTP ${res.status}`,
    };
  }
  return { success: true };
}

async function testDeepSeek(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.deepseek.com/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testMiniMax(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  // Validate via MiniMax's Anthropic-compatible endpoint with a minimal request.
  const res = await fetch("https://api.minimax.io/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "MiniMax-M2.5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    return {
      success: false,
      error: body?.error?.message ?? "Invalid API key",
    };
  }
  return { success: true };
}

async function testOpenRouter(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testVoyageAI(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  // VoyageAI doesn't have a /models endpoint; do a tiny embed call
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: ["test"], model: "voyage-3-lite" }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.detail ?? body?.error?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testCohere(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.cohere.com/v2/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testGoogleAI(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1/models",
    { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testGroq(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testMistral(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://api.mistral.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testGitHub(token: string): Promise<TestCredentialResponse> {
  if (!token) return { success: false, error: "Token is required" };

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

function testWhatsApp(): TestCredentialResponse {
  // WhatsApp uses QR code pairing, not API keys. The test just checks
  // if the channel is registered. Actual connectivity is verified by
  // the connection.update events in the adapter.
  return { success: true };
}

async function testNotion(token: string): Promise<TestCredentialResponse> {
  if (!token) return { success: false, error: "Token is required" };

  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testMatrix(
  homeserverUrl: string,
  accessToken: string,
): Promise<TestCredentialResponse> {
  if (!homeserverUrl || !accessToken)
    return { success: false, error: "Homeserver URL and access token are required" };

  try {
    assertSafeUrl(homeserverUrl, "Homeserver URL");
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const res = await fetch(
    `${homeserverUrl.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testOllama(baseUrl: string): Promise<TestCredentialResponse> {
  if (!isLocalUrl(baseUrl)) {
    return { success: false, error: "Base URL must point to localhost or a .local address" };
  }
  const ollamaBase = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${ollamaBase}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { success: false, error: `Ollama unreachable: HTTP ${res.status}` };
    }
    return { success: true };
  } catch {
    return { success: false, error: `Cannot reach Ollama at ${ollamaBase}. Is it running?` };
  }
}

async function testOllamaCloud(apiKey: string): Promise<TestCredentialResponse> {
  if (!apiKey) return { success: false, error: "API key is required" };

  const res = await fetch("https://ollama.com/api/tags", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.error ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testLMStudio(baseUrl: string): Promise<TestCredentialResponse> {
  if (!isLocalUrl(baseUrl)) {
    return { success: false, error: "Base URL must point to localhost or a .local address" };
  }
  try {
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const res = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { success: false, error: `LM Studio unreachable: HTTP ${res.status}` };
    }
    return { success: true };
  } catch {
    return { success: false, error: `Cannot reach LM Studio at ${baseUrl}. Is it running?` };
  }
}

async function testVLLM(baseUrl: string, apiKey?: string): Promise<TestCredentialResponse> {
  if (!isLocalUrl(baseUrl)) {
    return { success: false, error: "Base URL must point to localhost or a .local address" };
  }
  try {
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { success: false, error: `vLLM unreachable: HTTP ${res.status}` };
    }
    return { success: true };
  } catch {
    return { success: false, error: `Cannot reach vLLM at ${baseUrl}. Is it running?` };
  }
}

async function testObsidian(vaultPath: string): Promise<TestCredentialResponse> {
  if (!vaultPath) return { success: false, error: "Vault path is required" };

  const fs = await import("node:fs/promises");
  try {
    const stat = await fs.stat(vaultPath);
    if (!stat.isDirectory())
      return { success: false, error: "Path is not a directory" };
    return { success: true };
  } catch {
    return { success: false, error: "Path does not exist or is inaccessible" };
  }
}

async function testGitLab(
  instanceUrl: string,
  token: string,
): Promise<TestCredentialResponse> {
  if (!instanceUrl || !token)
    return { success: false, error: "Instance URL and token are required" };

  try {
    assertSafeUrl(instanceUrl, "GitLab instance URL");
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const res = await fetch(
    `${instanceUrl.replace(/\/$/, "")}/api/v4/user`,
    {
      headers: { "PRIVATE-TOKEN": token },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testJira(
  domain: string,
  email: string,
  apiToken: string,
): Promise<TestCredentialResponse> {
  if (!domain || !email || !apiToken)
    return { success: false, error: "Domain, email, and API token are required" };

  const jiraUrl = `https://${domain}/rest/api/3/myself`;
  try {
    assertSafeUrl(jiraUrl, "Jira domain");
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const res = await fetch(jiraUrl, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}

async function testHomeAssistant(
  instanceUrl: string,
  token: string,
): Promise<TestCredentialResponse> {
  if (!instanceUrl || !token)
    return { success: false, error: "Instance URL and token are required" };

  // Home Assistant is typically local — skip SSRF check for local URLs
  if (!isLocalUrl(instanceUrl)) {
    try {
      assertSafeUrl(instanceUrl, "Home Assistant instance URL");
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const res = await fetch(`${instanceUrl.replace(/\/$/, "")}/api/`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    return { success: false, error: body?.message ?? `HTTP ${res.status}` };
  }
  return { success: true };
}
