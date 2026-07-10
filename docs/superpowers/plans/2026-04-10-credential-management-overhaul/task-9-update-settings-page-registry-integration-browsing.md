# Credential Management Overhaul — Task 9: Update Settings Page — Registry Integration Browsing

## Task 9: Update Settings Page — Registry Integration Browsing

**Files:**
- Modify: `apps/client/src/components/panels/SettingsPanel.tsx`
- Modify: `apps/client/src/components/credentials/AddCredentialDialog.tsx`

- [ ] **Step 1: Update AddCredentialDialog to use CredentialForm for custom integrations**

Read the current `AddCredentialDialog.tsx` to understand its structure:

```bash
head -50 apps/client/src/components/credentials/AddCredentialDialog.tsx
```

Add a "Custom Integration" option to the provider selection grid. When selected, it shows a blank CredentialForm with `allowFieldEditing: true` where the user defines their own fields.

The exact code depends on the current dialog structure — adapt to match existing patterns. Key change: add a "Custom" card at the end of the provider grid that opens CredentialForm with:

```tsx
<CredentialForm
  providerName="Custom Integration"
  credentialType=""
  fields={[{ key: "apiKey", label: "API Key", type: "password" }]}
  suggestedName=""
  source="ai-research"
  allowFieldEditing={true}
  onSubmit={handleCustomSave}
  onCancel={onClose}
/>
```

- [ ] **Step 2: Add "Available from Registry" section to SettingsPanel**

In the Connections/Credentials section of `SettingsPanel.tsx` (`CredentialsContent` component), add a section below the existing credential list that shows registry tools with credential requirements.

This should reuse the existing `useRegistryStore` to search for tools:

```tsx
import { useRegistryStore } from "../../stores/registry-store.ts";

// Inside CredentialsContent component:
const { entries, search, loading: registryLoading } = useRegistryStore();
const toolsWithCreds = entries.filter((e) => e.kind === "tool" && e.credentials);
```

Add a search bar and grid of available integrations from the registry. When a user clicks one, it triggers installation + credential collection using the same flow.

The exact implementation depends on the current SettingsPanel structure. Key principle: reuse existing `RegistryBrowserPanel` patterns filtered to tools with `credentials` blocks.

- [ ] **Step 3: Add "Research" button for unknown integrations**

Below the registry search results, add a fallback:

```tsx
{searchQuery && toolsWithCreds.length === 0 && (
  <div className="text-center py-4">
    <p className="text-sm text-white/40 mb-2">Not found in registry</p>
    <button
      onClick={() => handleResearch(searchQuery)}
      className="px-4 py-2 text-sm rounded-lg bg-white/10 text-white/70 hover:bg-white/20"
    >
      Research "{searchQuery}" with AI
    </button>
  </div>
)}
```

The `handleResearch` function calls `GET /api/integrations/research?q=...` and opens a CredentialForm with the results.

- [ ] **Step 4: Verify client compiles and Settings page works**

```bash
cd apps/client && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/panels/SettingsPanel.tsx apps/client/src/components/credentials/AddCredentialDialog.tsx
git commit -m "feat: add registry browsing and custom integration to Settings

Settings > Integrations now shows: installed credentials, available registry tools,
and a custom integration option. AI research fallback for unknown services."
```

---
