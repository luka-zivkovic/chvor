# Credential Management Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flaky chat-based credential management with a registry-first, three-tier system (provider registry → Chvor registry → AI research fallback) where credentials are always collected via secure forms, never plain text.

**Architecture:** Three-tier integration resolution: Tier 1 checks hardcoded provider-registry.ts (LLM/channels), Tier 2 searches the Chvor registry for tool entries with embedded credential schemas, Tier 3 falls back to web search + LLM research. A shared credential form component is used by both the chat inline modal and the Settings page. Flaky files (credential-type-resolver, command-handlers, connection-config-resolver, old CredentialRequest) are deleted and replaced with clean implementations.

**Tech Stack:** TypeScript, Hono (server routes), Zustand (client state), React 19, Vitest, Zod (tool schemas), ai SDK (LLM calls)

**Spec:** `docs/superpowers/specs/2026-04-10-credential-management-overhaul-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `apps/server/src/lib/integration-resolver.ts` | Three-tier resolution: provider registry → Chvor registry → AI research |
| `apps/server/src/lib/integration-research.ts` | Tier 3: web search + LLM extraction for unknown services |
| `apps/server/src/routes/integrations.ts` | `GET /api/integrations/research?q=...` endpoint |
| `apps/server/src/lib/__tests__/integration-resolver.test.ts` | Tests for three-tier resolver |
| `apps/server/src/lib/__tests__/integration-research.test.ts` | Tests for Tier 3 research service |
| `apps/client/src/components/credentials/CredentialForm.tsx` | Shared credential form (chat modal + settings) |

### Modified Files
| File | Changes |
|------|---------|
| `packages/shared/src/types/credential.ts` | Add `CredentialSchema`, `IntegrationResolution`, `ProviderProposal` types |
| `packages/shared/src/types/api.ts` | Update `CredentialRequestData` to carry resolution metadata |
| `apps/server/src/lib/native-tools.ts` | Replace `native__request_credential` + add `native__research_integration`, remove `native__add_credential` |
| `apps/server/src/gateway/ws.ts` | Remove timeout handling from credential respond |
| `apps/server/src/index.ts` | Mount `/api/integrations` route |
| `apps/client/src/stores/app-store.ts` | Update credential request state for new data shape |
| `apps/client/src/components/chat/ChatPanel.tsx` | Use new CredentialForm in modal instead of old CredentialRequest |
| `apps/client/src/components/credentials/AddCredentialDialog.tsx` | Refactor to use shared CredentialForm |
| `apps/client/src/components/panels/SettingsPanel.tsx` | Add registry browsing + custom integration sections |

### Deleted Files
| File | Reason |
|------|--------|
| `apps/server/src/lib/credential-type-resolver.ts` | Replaced by integration-resolver.ts |
| `apps/server/src/lib/command-handlers.ts` | No more /addkey in chat |
| `apps/server/src/lib/connection-config-resolver.ts` | Auth discovery in tool defs or research |
| `apps/client/src/components/chat/CredentialRequest.tsx` | Replaced by shared CredentialForm |

---

## Task Files

- [Task 1: Delete Flaky Files + Clean Up References](2026-04-10-credential-management-overhaul/task-1-delete-flaky-files-clean-up-references.md)
- [Task 2: Add Shared Types](2026-04-10-credential-management-overhaul/task-2-add-shared-types.md)
- [Task 3: Build the Integration Resolver (Tier 1 + 2)](2026-04-10-credential-management-overhaul/task-3-build-the-integration-resolver-tier-1-2.md)
- [Task 4: Build the AI Research Service (Tier 3)](2026-04-10-credential-management-overhaul/task-4-build-the-ai-research-service-tier-3.md)
- [Task 5: Rewrite Native Tools (research + request)](2026-04-10-credential-management-overhaul/task-5-rewrite-native-tools-research-request.md)
- [Task 6: Update WebSocket Handler (Remove Timeout)](2026-04-10-credential-management-overhaul/task-6-update-websocket-handler-remove-timeout.md)
- [Task 7: Build Shared CredentialForm Component](2026-04-10-credential-management-overhaul/task-7-build-shared-credentialform-component.md)
- [Task 8: Wire CredentialForm into ChatPanel](2026-04-10-credential-management-overhaul/task-8-wire-credentialform-into-chatpanel.md)
- [Task 9: Update Settings Page — Registry Integration Browsing](2026-04-10-credential-management-overhaul/task-9-update-settings-page-registry-integration-browsing.md)
- [Task 10: End-to-End Verification](2026-04-10-credential-management-overhaul/task-10-end-to-end-verification.md)

## Notes

This index replaces a previously monolithic implementation plan. Each task file is kept below the 1000-line project limit.
