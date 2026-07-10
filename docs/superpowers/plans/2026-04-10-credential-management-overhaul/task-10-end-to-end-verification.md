# Credential Management Overhaul — Task 10: End-to-End Verification

## Task 10: End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all server tests**

```bash
pnpm --filter @chvor/server test
```

Expected: All tests pass, including new integration-resolver and integration-research tests.

- [ ] **Step 2: Run all client tests**

```bash
pnpm --filter @chvor/client test
```

Expected: All tests pass.

- [ ] **Step 3: Run full TypeScript type check**

```bash
cd packages/shared && pnpm tsc --noEmit && cd ../../apps/server && pnpm tsc --noEmit && cd ../client && pnpm tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Manual test — Chat flow (Tier 1)**

1. Start the app
2. In chat, say "I want to add my Anthropic API key"
3. AI should call `native__research_integration` → find in provider registry
4. AI confirms with user → calls `native__request_credential`
5. Inline CredentialForm appears with "Built-in" badge
6. Fill in API key → save → verify credential appears in Settings

- [ ] **Step 5: Manual test — Settings flow**

1. Open Settings → Integrations
2. Click "+ Add" → verify provider grid shows known providers
3. Select a provider → verify CredentialForm renders correctly
4. Browse "Available from Registry" section → verify registry tools listed
5. Click "Custom Integration" → verify editable form appears

- [ ] **Step 6: Verify old flaky code is gone**

```bash
# These should all return "not found" / no results
ls apps/server/src/lib/credential-type-resolver.ts 2>&1
ls apps/server/src/lib/command-handlers.ts 2>&1
ls apps/server/src/lib/connection-config-resolver.ts 2>&1
ls apps/client/src/components/chat/CredentialRequest.tsx 2>&1
grep -rn "addkey" apps/server/src/lib/ 2>&1
grep -rn "native__add_credential" apps/server/src/lib/native-tools.ts 2>&1
```

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: credential management overhaul complete

Three-tier credential resolution (provider registry → Chvor registry → AI research).
Shared CredentialForm component for chat and settings.
Removed: credential-type-resolver, command-handlers, connection-config-resolver, old CredentialRequest."
```
