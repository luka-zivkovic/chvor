# Credential Management Overhaul — Task 6: Update WebSocket Handler (Remove Timeout)

## Task 6: Update WebSocket Handler (Remove Timeout)

**Files:**
- Modify: `apps/server/src/gateway/ws.ts`

- [ ] **Step 1: Update credential.respond handler**

In `apps/server/src/gateway/ws.ts` (around lines 183-192), the handler is already correct — it calls `resolveCredentialRequest()`. No changes needed to the handler itself.

However, verify the import of `resolveCredentialRequest` still works since we moved it in Task 5. Check:

```bash
grep -n "resolveCredentialRequest" apps/server/src/gateway/ws.ts
```

The import should point to `../lib/native-tools.ts`. If it's correct, no changes needed here.

- [ ] **Step 2: Verify no timeout references remain**

```bash
grep -rn "CREDENTIAL_REQUEST_TIMEOUT" apps/server/src/
```

Should return nothing. If any remain, remove them.

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add apps/server/src/gateway/ws.ts
git commit -m "fix: clean up credential timeout references in WS handler"
```

---
