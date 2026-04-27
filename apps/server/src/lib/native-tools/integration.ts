import { tool } from "ai";
import { z } from "zod";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Research integration (three-tier lookup)
// ---------------------------------------------------------------------------

const RESEARCH_INTEGRATION_NAME = "native__research_integration";

const researchIntegrationToolDef = tool({
  description:
    "[Research Integration] Look up an integration/service to determine what credentials are needed. " +
    "Checks the built-in provider registry, then the Chvor tool registry, then falls back to AI-powered web research. " +
    "Call this BEFORE native__request_credential to determine what fields to collect. " +
    "Returns the integration details including required credential fields and source tier.",
  parameters: z.object({
    service: z.string().describe(
      "The service/integration name (e.g., 'NocoDB', 'Anthropic', 'GitHub', 'My CRM'). Any string accepted.",
    ),
  }),
});

const handleResearchIntegration: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const service = String(args.service);

  try {
    const { resolveIntegration } = await import("../integration-resolver.ts");
    const resolution = await resolveIntegration(service);

    if (resolution) {
      const fieldList = resolution.fields
        .map((f) => `  - ${f.key} (${f.label})${f.optional ? " [optional]" : ""}`)
        .join("\n");
      const existingNote = resolution.existingCredentialId
        ? `\nExisting credential found (id: ${resolution.existingCredentialId}). You can update it or create a new one.`
        : "";
      const registryNote = resolution.registryEntryId
        ? `\nRegistry entry: ${resolution.registryEntryId}${resolution.registryToolInstalled ? " (installed)" : " (not installed — will auto-install on request)"}`
        : "";

      return {
        content: [{
          type: "text",
          text: `Integration found: ${resolution.name}\n` +
            `Source: ${resolution.source}\n` +
            `Credential type: ${resolution.credentialType}\n` +
            `Required fields:\n${fieldList}${registryNote}${existingNote}\n\n` +
            `Call native__request_credential with these details to prompt the user for credentials.`,
        }],
      };
    }

    // Tier 3: AI-powered research
    const { researchIntegration } = await import("../integration-research.ts");
    const proposal = await researchIntegration(service);

    const fieldList = proposal.fields
      .map((f) => `  - ${f.key} (${f.label})${f.optional ? " [optional]" : ""}`)
      .join("\n");
    const helpNote = proposal.helpText ? `\nHelp: ${proposal.helpText}` : "";
    const authNote = proposal.authScheme ? `\nAuth scheme: ${proposal.authScheme}` : "";
    const baseUrlNote = proposal.baseUrl ? `\nBase URL: ${proposal.baseUrl}` : "";
    const specNote = proposal.specUrl
      ? `\nOpenAPI spec: ${proposal.specUrl} (verified: ${proposal.specVerified ? "yes" : "no"})`
      : "\nOpenAPI spec: not found";

    const confidenceExplain = proposal.confidence === "researched"
      ? "found via web search and LLM extraction"
      : proposal.confidence === "inferred"
        ? "inferred from AI training data — may be inaccurate"
        : "no info found; the user must enter API key + base URL manually";

    // OAuth2 services require a different flow — the user needs to register
    // a redirect URL with the provider, paste client_id/secret, and complete
    // the OAuth dance. request_credential cannot do this; request_oauth_setup
    // launches the wizard.
    const isOAuth = proposal.authScheme === "oauth2";
    const nextStepText = isOAuth
      ? `Next steps: (1) call native__request_oauth_setup with credentialType="${proposal.credentialType}", providerName="${proposal.name}"` +
        `${proposal.authUrl ? `, authUrl="${proposal.authUrl}"` : ""}` +
        `${proposal.tokenUrl ? `, tokenUrl="${proposal.tokenUrl}"` : ""}` +
        `${proposal.scopes && proposal.scopes.length ? `, scopes=${JSON.stringify(proposal.scopes)}` : ""}` +
        `${proposal.helpText ? `, helpText="${proposal.helpText}"` : ""}` +
        ` to launch the OAuth wizard, then (2) call native__synthesize_tool with credentialType="${proposal.credentialType}", baseUrl="${proposal.baseUrl ?? ""}", authScheme="oauth2"` +
        `${proposal.specUrl && proposal.specVerified ? `, openApiSpecUrl="${proposal.specUrl}"` : " (no verified spec — provide endpoints[] explicitly)"} ` +
        `to create the callable tool. DO NOT call native__request_credential for oauth2 — it cannot run the redirect flow.`
      : `Next steps: (1) call native__request_credential with source="ai-research", confidence="${proposal.confidence}"` +
        `${proposal.authScheme ? `, authScheme="${proposal.authScheme}"` : ""}` +
        `${proposal.baseUrl ? `, baseUrl="${proposal.baseUrl}"` : ""}` +
        `${proposal.probePath ? `, probePath="${proposal.probePath}"` : ""}` +
        `${proposal.specUrl ? `, specUrl="${proposal.specUrl}", specVerified=${proposal.specVerified ? "true" : "false"}` : ""}` +
        ` to collect the credential, ` +
        `then (2) call native__synthesize_tool with credentialType="${proposal.credentialType}", baseUrl="${proposal.baseUrl ?? ""}", ` +
        `authScheme="${proposal.authScheme ?? "bearer"}"` +
        `${proposal.specUrl && proposal.specVerified ? `, openApiSpecUrl="${proposal.specUrl}"` : " (no verified spec — provide endpoints[] explicitly or admit you can't synthesize tools yet)"} ` +
        `to create the callable tool.`;

    return {
      content: [{
        type: "text",
        text: `Integration researched: ${proposal.name}\n` +
          `Source: ai-research (confidence: ${proposal.confidence})\n` +
          `Credential type: ${proposal.credentialType}\n` +
          `Required fields:\n${fieldList}${authNote}${baseUrlNote}${specNote}${helpNote}\n\n` +
          `Note: This was ${confidenceExplain}. ` +
          `Field names may need adjustment.\n` +
          nextStepText,
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `Failed to research integration "${service}": ${err instanceof Error ? err.message : String(err)}. ` +
          `The user can add credentials manually via Settings > Integrations.`,
      }],
    };
  }
};

export const integrationModule: NativeToolModule = {
  defs: { [RESEARCH_INTEGRATION_NAME]: researchIntegrationToolDef },
  handlers: { [RESEARCH_INTEGRATION_NAME]: handleResearchIntegration },
  mappings: { [RESEARCH_INTEGRATION_NAME]: { kind: "tool", id: "credentials" } },
};
