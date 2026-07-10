# Use-Case Coverage & Capability Gaps

**Purpose.** This document maps a set of realistic power-user automation scenarios against Chvor's _actual_ implemented capabilities (verified in code, not docs), scores coverage, and specifies the gaps to close — with concrete implementation guidance so the work can be picked up in a fresh conversation. Deployment target: **single-user, self-hosted**.

**How to use this doc:** the prioritized gaps in §4 are the actionable backlog. Each has a problem statement, the use cases it unblocks, current state with file pointers, a proposed approach, and a rough effort. Start at Gap 1.

> This is a tactical capability audit. The authoritative cross-platform delivery order and PR gates live in [platform-evolution-batches.md](./platform-evolution-batches.md).

---

## 1. Capability baseline (what's already solid)

These are confirmed working and form the foundation — most scenarios fail on a _specific missing connector_, not the core engine.

| Capability                                                                                                       | Status                                                    | Key files                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Scheduling (cron)** — "every morning", "Friday 5pm", one-shot                                                  | ✅ user-configurable, persistent                          | `apps/server/src/lib/scheduler.ts`, `db/schedule-store.ts`, `lib/native-tools/schedule.ts` |
| **Messaging channels** — Telegram, Slack, Discord, WhatsApp, Matrix; send+receive, **image/file receive**, voice | ✅ first-class                                            | `apps/server/src/channels/*.ts`                                                            |
| **HITL approval** — "approve before posting", "ping if risky"; Telegram inline buttons                           | ✅ durable gate                                           | `lib/approval-gate-hitl.ts`, `routes/approvals.ts`                                         |
| **Web fetch (arbitrary URL)** — HN/Reddit JSON, RSS XML                                                          | ✅                                                        | `lib/native-tools/web.ts` (`native__web_request`)                                          |
| **Web search** — DuckDuckGo scrape (no key)                                                                      | ⚠️ basic                                                  | `lib/native-tools/web.ts` (`native__web_search`)                                           |
| **Browser automation** — visit + read pricing pages, screenshots                                                 | ✅ Stagehand/Playwright                                   | `lib/native-tools/browser.ts`                                                              |
| **Model vision on inbound images** — read receipts/screenshots                                                   | ✅ via LLM (no dedicated OCR tool)                        | channels pass `imageData`; orchestrator multimodal                                         |
| **Knowledge ingestion + recall** — PDFs/URLs → memory → answer later                                             | ✅ RAG                                                    | `lib/native-tools/knowledge.ts`, `lib/knowledge-ingestor.ts`, `db/memory/`                 |
| **Long-term memory** — "from what we last discussed"                                                             | ✅ graph + recall                                         | `db/memory/`, `lib/native-tools/recall.ts`                                                 |
| **Research → synthesize → call any API** — e.g. Stripe                                                           | ✅                                                        | `lib/native-tools/integration.ts`, `synthesized.ts`, `synthesized-caller.ts`               |
| **Claude Code agent** — write/refactor/review code                                                               | ✅ spawn CLI                                              | `lib/native-tools/claude-code.ts`                                                          |
| **Shell / sandboxed code exec**                                                                                  | ✅ (shell w/ approval; Docker sandbox, no net by default) | `lib/native-tools/shell.ts`, `sandbox.ts`                                                  |
| **Workflows** — bundle multi-step procedures                                                                     | ✅                                                        | `lib/native-tools/workflow.ts`                                                             |
| **Webhooks** — GitHub / Notion / Gmail event sources                                                             | ✅                                                        | `lib/native-tools/webhook.ts`, `db/webhook-store.ts`                                       |
| **First-class integrations** — GitHub, Notion, GitLab, Jira, SMTP, Home Assistant, ElevenLabs                    | ✅ built-in credential types + bundled tools              | `lib/provider-registry.ts`, `apps/server/data/bundled-tools/`                              |
| **OAuth (direct)** — Google (Gmail/Calendar/Drive), Reddit only                                                  | ⚠️ user supplies own OAuth app                            | `lib/oauth-providers.ts`, `lib/oauth-engine.ts`                                            |
| **OAuth (via Composio bridge)** — X/Twitter, LinkedIn, YouTube, Instagram, TikTok, etc.                          | ⚠️ needs paid Composio API key                            | `lib/provider-registry.ts` (OAUTH_PROVIDERS), `lib/composio-client.ts`                     |

---

## 2. Per-use-case coverage

Verdict key: ✅ works today · ⚠️ works with setup / reliability risk · ❌ real gap.

| #   | Use case                                                                                       | Verdict | Blocking gap(s)                                               |
| --- | ---------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| 1   | Morning: scan HN/Reddit/RSS → draft LinkedIn + Notion → Telegram approve before post           | ⚠️      | LinkedIn needs Composio; relevance ranking is model-judgment  |
| 2   | Slack YouTube link → transcribe → tweet thread → queue to X                                    | ❌      | No transcription tool; X needs Composio; no "queue" primitive |
| 3   | Watch repo → on PR open Claude Code reviews diff, runs tests, comments, pings Discord if risky | ⚠️      | No arbitrary-repo test-run env; chain not wired turnkey       |
| 4   | Friday 5pm: group open GitHub issues → prioritized list to Telegram                            | ✅      | —                                                             |
| 5   | Build landing page with Claude Code → push to GitHub → deploy to server → send URL             | ❌      | No deploy/SSH primitive                                       |
| 6   | 8am: Gmail + Calendar digest → one Telegram message                                            | ⚠️      | Google OAuth app onboarding friction                          |
| 7   | Forward receipt photo → read amount/vendor/date → append Notion row                            | ✅      | (model-vision accuracy caveat)                                |
| 8   | Sunday: per-meeting prep notes from calendar + memory → Notion                                 | ⚠️      | Recall precision per meeting                                  |
| 9   | Daily: check 3 competitor pricing pages → WhatsApp only if changed                             | ⚠️      | No change-detection primitive                                 |
| 10  | Research Stripe API → set up as tool → answer "revenue this week" from live data               | ✅      | —                                                             |
| 11  | Ingest 20 PDFs/URLs → answer company-policy questions                                          | ✅      | (chunking fidelity on long docs)                              |
| 12  | "ship it" → GitHub release + Discord changelog + Notion Releases update                        | ⚠️      | GitHub release action unconfirmed; changelog needs git step   |

---

## 3. Cross-cutting risk

Every scheduled, unattended, multi-step chain shares one risk: **partial mid-chain failure**. The daemon has retry (`lib/daemon-engine.ts`), but there is no per-workflow "resume from step N / report exactly what failed" guarantee. Before promising "runs while you sleep," add step-level checkpointing + a failure summary delivered to the user's channel. (See Gap 7.)

---

## 4. Prioritized gaps to implement

Ordered by leverage (how many scenarios each unblocks × how blocking it is).

### Gap 1 — Monitoring / change-detection primitive ⭐ highest leverage

**Unblocks:** #9 (pricing), #1/#2 (only-new-items), partially #3.
**Problem:** "only message me if it changed", "only new threads", "queue" all need stored last-state + a diff. Today cron + memory can fake it, but there's no first-class primitive, so reliability rests on the agent re-deriving and comparing state each run (false pings / misses).
**Current state:** `scheduler.ts` runs a prompt on a cron; no durable per-monitor state store; memory is the only persistence and isn't designed for exact-match diffing.
**Proposed approach:**

- New store `db/monitor-store.ts`: `monitors(id, name, fetch_spec, selector/normalizer, last_value_hash, last_value_snapshot, schedule, deliver_to, notify_on='change', created_at)`.
- New native tool `native__create_monitor` (mirror `schedule.ts`): captures _what to fetch_ (URL / browser extract / tool call), _how to normalize_ (so noise like timestamps doesn't trigger), and _where to notify_.
- Scheduler executes the monitor: fetch → normalize → hash → compare to `last_value_hash` → only run the notify/act prompt on change → persist new snapshot. Keep a short diff for the notification.
- Reuse `scheduler.ts` arming and channel-delivery (`deliver_to`).
  **Effort:** Medium (1 store + 1 tool + scheduler branch + tests).

### Gap 2 — Deploy / remote-exec primitive

**Unblocks:** #5 (landing page deploy).
**Problem:** No way to deploy built code; only a pre-existing host script run via shell works, and "send live URL" has no verification.
**Current state:** `lib/native-tools/shell.ts` can run commands with approval; no SSH, no provider deploy, no URL healthcheck.
**Proposed approach (pick the smallest that fits the user):**

- Minimal: a documented **deploy skill** that standardizes `git push` + a host-side `deploy.sh`, then an HTTP healthcheck on the resulting URL (reuse `synthesized/network.ts` safe fetch) before reporting success.
- Better: `native__deploy` supporting (a) SSH to a configured host (credential type `ssh`: host/user/key) running a deploy command, or (b) a static-host provider (Netlify/Vercel/Cloudflare Pages) via their deploy API synthesized as a tool. Verify the live URL returns 2xx before declaring done.
  **Effort:** Medium–High (SSH path needs a new credential type + exec; static-host path is a synthesized tool + thin wrapper).

### Gap 3 — Media transcription tool

**Unblocks:** #2 (YouTube → tweet thread); also any "summarize this video/voice note from a link".
**Problem:** No tool to get a transcript from a YouTube/media URL. (Inbound _voice notes_ are already transcribed per-channel; this is about _links_.)
**Proposed approach:**

- `native__transcribe(url)`: for YouTube, fetch the timed-text/captions track (or synthesize the YouTube Data API as a tool); for arbitrary audio/video, download (size-capped, via safe fetch) → pipe to an STT provider already used for voice notes (find the existing STT path used by Telegram/WhatsApp voice and reuse it).
- Fall back to "no transcript available" cleanly (don't hallucinate).
  **Effort:** Medium (captions path is light; full A/V STT reuses existing transcription).

### Gap 4 — Turnkey GitHub PR-CI loop

**Unblocks:** #3 (review + test + comment on PR open).
**Problem:** The parts exist (GitHub webhook source, GitHub tool for diff/comment, `native__claude_code`, shell), but there's **no environment to run an arbitrary repo's tests** (Docker `sandbox` has no network/repo by default) and the chain isn't wired.
**Current state:** `webhook.ts` (GitHub source) → prompt; `claude-code.ts` review; GitHub bundled tool for read/comment. Missing: ephemeral checkout + test run with the repo's toolchain.
**Proposed approach:**

- A "PR review" workflow template triggered by the GitHub PR webhook: clone the PR head into a temp dir (shell, approval-exempt for the configured repo), run the repo's test command in a constrained shell (or an opt-in networked sandbox profile), feed diff + test output to `native__claude_code` for review, post the summary via the GitHub tool, conditionally ping Discord.
- Confirm the bundled GitHub tool actually exposes **PR diff read** and **issue-comment create** (audit `apps/server/data/bundled-tools/github.md`); if not, synthesize those endpoints.
  **Effort:** High (test-execution environment is the hard part; consider scoping to "review + comment", deferring auto-test, as a v1).

### Gap 5 — Reduce external/paid dependency for social posting

**Unblocks:** cleaner #1, #2 (X/Twitter, LinkedIn).
**Problem:** X and LinkedIn posting only work through the **Composio bridge** (paid external API key). Not ideal for self-hosted.
**Current state:** `OAUTH_PROVIDERS` routes these to Composio; only Google + Reddit are direct OAuth.
**Proposed approach:** add **direct OAuth providers** for X (OAuth2/PKCE) and LinkedIn to `lib/oauth-providers.ts` + `provider-registry.ts`, then synthesize their post endpoints. NOTE: this depends on the deferred **OAuth completeness** work (unify the two OAuth registries, first-class "Add OAuth app" UI, no-refresh-token handling) — see `docs/superpowers/plans/2026-04-10-credential-management-overhaul.md` and the plan file referenced in §6.
**Effort:** Medium per provider, gated on the OAuth-completeness prerequisite.

### Gap 6 — Google OAuth onboarding friction

**Unblocks:** smoother #6, #8 (Gmail/Calendar).
**Problem:** User must hand-create a Google Cloud OAuth app (client id/secret); the "add OAuth app" UX is rough (per the credential-management audit).
**Proposed approach:** first-class "Add OAuth app" settings flow (client id/secret entry + redirect-URI guidance) — this is already a documented deferred item from the credential overhaul. Closing it improves every direct-OAuth integration at once.
**Effort:** Medium (UI + wiring); shared with Gap 5.

### Gap 7 — Workflow step-checkpointing + failure reporting

**Unblocks:** reliability of every scheduled multi-step scenario (#1, #3, #5, #12…).
**Problem:** Partial mid-chain failure has no resume/report guarantee.
**Proposed approach:** persist per-step results in `workflow.ts` execution; on failure, deliver a concise "completed steps 1–3, failed at step 4 because X" message to the user's channel; optionally allow "resume". Lean on existing daemon retry for transient errors.
**Effort:** Medium.

### Gap 8 — Confirm/add GitHub release + changelog

**Unblocks:** #12 ("ship it").
**Problem:** GitHub **release creation** is unconfirmed in the bundled tool; changelog needs a git-log step.
**Proposed approach:** audit the GitHub bundled tool; if release/tag endpoints are missing, synthesize them. Add a small "changelog since last tag" shell/git step. Discord + Notion sides already work.
**Effort:** Low–Medium.

---

## 5. Suggested build sequence

1. **Gap 1 (monitoring primitive)** — highest leverage, self-contained, no external deps.
2. **Gap 7 (checkpointing/failure reporting)** — makes everything else trustworthy unattended.
3. **Gap 6 + Gap 5 (OAuth completeness → direct X/LinkedIn)** — one prerequisite unlocks several social/Google scenarios; coordinate with the credential-overhaul follow-ups.
4. **Gap 3 (transcription)** — unblocks #2 cleanly.
5. **Gap 8 (GitHub release)** — quick win for #12.
6. **Gap 2 (deploy)** — scope to SSH-or-static-host based on the user's actual hosting.
7. **Gap 4 (PR-CI loop)** — largest; consider shipping "review + comment" first, defer auto-test.

---

## 6. Related context for the implementer

- **Credential/OAuth foundation** was recently hardened (auth dedup, SSRF IP parsing, secret redaction, OAuth refresh/retry, encryption-key env override) and several multi-tenant features were intentionally simplified for single-user. The **deferred** items most relevant here — OAuth registry unification, new built-in OAuth providers, the first-class "Add OAuth app" UI, no-refresh-token handling — are prerequisites for Gaps 5 & 6. See `docs/superpowers/plans/2026-04-10-credential-management-overhaul.md`.
- **Reuse, don't rebuild:** `scheduler.ts` (cron + channel delivery) is the template for Gap 1's monitor execution; `synthesized/network.ts` for any safe outbound fetch (SSRF-guarded); the per-channel voice-transcription path for Gap 3's STT; `approval-gate-hitl.ts` for any new write action that should gate on user approval.
- **Verification pattern for new tools:** add a vitest under `apps/server/src/**/__tests__/`, keep files under the 1000-line limit (`node scripts/check-file-line-limit.mjs`), and run `pnpm --filter @chvor/server typecheck` + `npx vitest run`.
