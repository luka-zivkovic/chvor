# Credential Management Overhaul — Task 1: Delete Flaky Files + Clean Up References

## Task 1: Delete Flaky Files + Clean Up References

**Files:**
- Delete: `apps/server/src/lib/credential-type-resolver.ts`
- Delete: `apps/server/src/lib/command-handlers.ts`
- Delete: `apps/server/src/lib/connection-config-resolver.ts`
- Delete: `apps/client/src/components/chat/CredentialRequest.tsx`
- Modify: `apps/server/src/lib/native-tools.ts` (remove imports of deleted modules)
- Modify: `apps/client/src/components/chat/ChatPanel.tsx` (remove CredentialRequest import/usage)

- [ ] **Step 1: Delete the four flaky files**

```bash
rm apps/server/src/lib/credential-type-resolver.ts
rm apps/server/src/lib/command-handlers.ts
rm apps/server/src/lib/connection-config-resolver.ts
rm apps/client/src/components/chat/CredentialRequest.tsx
```

- [ ] **Step 2: Remove imports of deleted modules from native-tools.ts**

In `apps/server/src/lib/native-tools.ts`, the `handleRequestCredential` function (line 1571) imports from `credential-type-resolver.ts` and `connection-config-resolver.ts`. Comment out or stub the entire `handleRequestCredential` function body temporarily — it will be rewritten in Task 5. Replace lines 1571-1697 with a stub:

```typescript
async function handleRequestCredential(
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  return { content: [{ type: "text", text: "Credential request is being redesigned. Please add credentials via Settings > Integrations." }] };
}
```

Also check if `command-handlers.ts` is imported anywhere else (grep for `command-handlers`). Remove those imports.

- [ ] **Step 3: Remove CredentialRequest from ChatPanel.tsx**

In `apps/client/src/components/chat/ChatPanel.tsx`, remove the import of `CredentialRequest` and the JSX that renders `<CredentialRequest>` components (around lines 375-382). Leave the `pendingCredentialRequests` state reference — it will be reconnected in Task 7.

- [ ] **Step 4: Verify the app still builds**

```bash
cd apps/server && pnpm tsc --noEmit 2>&1 | head -30
cd apps/client && pnpm tsc --noEmit 2>&1 | head -30
```

Fix any remaining broken imports. The goal is a clean compile with the credential request flow temporarily stubbed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove flaky credential management files (type resolver, command handlers, connection config resolver, old CredentialRequest)

Start fresh for credential management overhaul. The native__request_credential
tool is temporarily stubbed — will be rewritten with three-tier resolution."
```

---
