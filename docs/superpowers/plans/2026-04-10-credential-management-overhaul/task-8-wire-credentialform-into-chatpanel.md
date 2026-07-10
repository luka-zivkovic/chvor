# Credential Management Overhaul — Task 8: Wire CredentialForm into ChatPanel

## Task 8: Wire CredentialForm into ChatPanel

**Files:**
- Modify: `apps/client/src/components/chat/ChatPanel.tsx`
- Modify: `apps/client/src/stores/app-store.ts`

- [ ] **Step 1: Update app-store to handle new CredentialRequestData shape**

In `apps/client/src/stores/app-store.ts`, the `credential.request` handler (around line 516) should already work since `CredentialRequestData` was updated in-place. Verify the `respondToCredentialRequest` function:

```bash
grep -A5 "respondToCredentialRequest" apps/client/src/stores/app-store.ts
```

It should remove the request from `pendingCredentialRequests`. If it references any old fields (like `suggestion`), update accordingly.

- [ ] **Step 2: Add CredentialForm to ChatPanel**

In `apps/client/src/components/chat/ChatPanel.tsx`, add the import and render `CredentialForm` for each pending request. Replace the section where `<CredentialRequest>` was previously rendered (removed in Task 1):

```tsx
import { CredentialForm } from "../credentials/CredentialForm.tsx";
```

In the JSX, where pending credential requests are rendered, add:

```tsx
{pendingCredentialRequests.map((request) => (
  <CredentialForm
    key={request.requestId}
    providerName={request.providerName}
    credentialType={request.credentialType}
    fields={request.fields}
    suggestedName={`${request.providerName} API Key`}
    source={request.source}
    confidence={request.confidence}
    helpText={request.helpText}
    allowFieldEditing={request.allowFieldEditing}
    existingCredentialId={request.existingCredentialId}
    onSubmit={(data) => {
      send({
        type: "credential.respond",
        data: {
          requestId: request.requestId,
          cancelled: false,
          data: data.fields,
          name: data.name,
        },
      });
      respondToCredentialRequest(request.requestId);
    }}
    onCancel={() => {
      send({
        type: "credential.respond",
        data: { requestId: request.requestId, cancelled: true },
      });
      respondToCredentialRequest(request.requestId);
    }}
  />
))}
```

- [ ] **Step 3: Verify client compiles**

```bash
cd apps/client && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/components/chat/ChatPanel.tsx apps/client/src/stores/app-store.ts
git commit -m "feat: wire CredentialForm into ChatPanel for inline credential collection

Replaces the old CredentialRequest component with the shared CredentialForm.
Supports all three resolution tiers with appropriate UI."
```

---
