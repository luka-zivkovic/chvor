# Credential Management Overhaul — Task 2: Add Shared Types

## Task 2: Add Shared Types

**Files:**
- Modify: `packages/shared/src/types/credential.ts`
- Modify: `packages/shared/src/types/api.ts`
- Test: `apps/server/src/lib/__tests__/integration-resolver.test.ts` (type-check only in this task)

- [ ] **Step 1: Add new types to credential.ts**

Add the following to the end of `packages/shared/src/types/credential.ts`:

```typescript
/** Schema for credential fields — embedded in registry tool definitions or from AI research. */
export interface CredentialSchema {
  type: string;              // credential type slug (e.g., "nocodb")
  name: string;              // display name (e.g., "NocoDB")
  fields: import("./provider.js").ProviderField[];
}

/** Result of the three-tier integration resolution. */
export interface IntegrationResolution {
  source: "provider-registry" | "chvor-registry" | "ai-research";
  /** Display name for the integration */
  name: string;
  /** Credential type slug */
  credentialType: string;
  /** Fields to collect from user */
  fields: import("./provider.js").ProviderField[];
  /** Chvor registry entry ID (Tier 2 only) */
  registryEntryId?: string;
  /** Whether the registry tool is already installed (Tier 2 only) */
  registryToolInstalled?: boolean;
  /** AI research proposal (Tier 3 only) */
  proposal?: ProviderProposal;
  /** Existing credential ID if one already exists for this type */
  existingCredentialId?: string;
}

/** AI-researched integration proposal (Tier 3). */
export interface ProviderProposal {
  name: string;
  credentialType: string;
  fields: import("./provider.js").ProviderField[];
  baseUrl?: string;
  authScheme?: string;
  helpText?: string;
  confidence: "researched" | "inferred";
}
```

- [ ] **Step 2: Update CredentialRequestData in api.ts**

Replace the `CredentialRequestData` interface in `packages/shared/src/types/api.ts` (lines 12-20):

```typescript
export interface CredentialRequestData {
  requestId: string;
  providerName: string;
  providerIcon: string;
  credentialType: string;
  fields: ProviderField[];
  /** Source tier of the resolution */
  source: "provider-registry" | "chvor-registry" | "ai-research";
  /** Chvor registry entry ID — client needs this to show "Installing from registry..." */
  registryEntryId?: string;
  /** Confidence level for AI-researched integrations */
  confidence?: "researched" | "inferred";
  /** General help/setup text */
  helpText?: string;
  /** Whether user can add/remove fields */
  allowFieldEditing: boolean;
  /** For updates — existing credential ID */
  existingCredentialId?: string;
  timestamp: string;
}
```

- [ ] **Step 3: Export new types from shared package index**

Check that `packages/shared/src/types/credential.ts` exports are re-exported from the package entry point. Grep for existing credential exports:

```bash
grep -n "credential" packages/shared/src/index.ts
```

The new types (`CredentialSchema`, `IntegrationResolution`, `ProviderProposal`) should be exported. Add if missing.

- [ ] **Step 4: Verify types compile**

```bash
cd packages/shared && pnpm tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/credential.ts packages/shared/src/types/api.ts
git commit -m "feat: add IntegrationResolution, CredentialSchema, ProviderProposal types

Three-tier credential resolution types for the overhaul: provider-registry,
chvor-registry, and ai-research sources."
```

---
