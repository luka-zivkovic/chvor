# Chvor Platform Evolution — Delivery Ledger

> Status: active
>
> Strategic source: [Inspiration Projects for Chvor](./inspiration-projects.md)
>
> Supporting capability audit: [Use-Case Coverage & Capability Gaps](./use-case-coverage-and-gaps.md)

## Delivery rule

Only one batch may be in progress at a time. Every batch follows the same gate:

1. Confirm scope, acceptance criteria, dependencies, and non-goals.
2. Start from synchronized `main` and create a dedicated branch.
3. Implement only that batch.
4. Add tests, migration coverage, and documentation proportional to risk.
5. Run local verification and review the complete diff.
6. Open a focused pull request.
7. Wait for CI and review; resolve every actionable comment.
8. Merge only after the final review is clean.
9. Synchronize and smoke-test `main` before selecting the next batch.

PRs should produce one independently useful result. A schema may land before its UI only when it has tested consumers or establishes a necessary compatibility boundary.

## Global invariants

Every batch must preserve these properties:

- Existing installations migrate forward without losing credentials, conversations, memories, schedules, or approvals.
- Credentials never appear in trajectory payloads, logs, events, eval fixtures, or screenshots.
- Every persisted format is versioned or migratable.
- New autonomous side effects use the existing approval and audit boundaries.
- Public API and WebSocket changes update shared types and compatibility tests.
- Server-owned state remains usable without a cloud dependency.
- A failed or interrupted migration leaves a diagnosable recovery path.
- Files remain below the repository line limit unless explicitly allowlisted.

## Status legend

| Status     | Meaning                                         |
| ---------- | ----------------------------------------------- |
| Planned    | Scope is defined but work has not started       |
| Active     | The only batch currently allowed to change code |
| In review  | PR is open; later batches remain blocked        |
| Merged     | PR is merged and `main` has been verified       |
| Superseded | Replaced by an explicitly linked decision       |

## Batch ledger

### B00 — Credential-management baseline

- **Status:** Merged
- **PR:** [#104](https://github.com/luka-zivkovic/chvor/pull/104)
- **Outcome:** Establish a clean, tested baseline for credential editing, OAuth refresh, synthesized authentication, URL safety, HITL timeouts, and oversized-module decomposition.
- **Acceptance evidence:** CI passed, 578 local tests passed with one skipped, all TypeScript projects compiled, client production build passed, fresh server boot applied all migrations and returned a healthy response.

### B01 — Strategy and delivery ledger

- **Status:** Merged
- **PR:** [#105](https://github.com/luka-zivkovic/chvor/pull/105)
- **Dependencies:** B00
- **Outcome:** Put the inspiration research, capability-gap audit, and this ordered PR ledger under version control.
- **Acceptance criteria:**
  - Every planned batch has a bounded outcome, dependencies, acceptance criteria, and non-goals.
  - The ledger names authoritative evidence required for completion.
  - Research documents link to primary project documentation.
  - Generated local package-manager state is ignored.
- **Non-goals:** No runtime, database, API, or UI behavior changes.

## Track A — Inspectable execution and evaluation

### A01 — Canonical trajectory contract

- **Status:** Merged
- **PR:** [#106](https://github.com/luka-zivkovic/chvor/pull/106)
- **Dependencies:** B01
- **Outcome:** Define the engine-neutral, versioned representation of an agent run and its steps.
- **Scope:** Shared types and Zod schemas for trajectory, step, actor, model usage, tool call, approval reference, error, timing, and redacted artifact references.
- **Acceptance criteria:**
  - Schemas round-trip representative chat, scheduled, channel, tool, approval, and failure runs.
  - Unknown future event fields are handled according to an explicit compatibility rule.
  - Secret-like fields are rejected or redacted in fixtures and serialization tests.
  - The contract does not import Pi, AI SDK, Hono, or client types.
- **Non-goals:** Persistence, orchestration instrumentation, API routes, or UI.

### A02 — Trajectory persistence

- **Status:** Merged
- **PR:** [#107](https://github.com/luka-zivkovic/chvor/pull/107)
- **Dependencies:** A01
- **Outcome:** Persist append-only trajectories and steps in SQLite.
- **Scope:** Migration, store, retention configuration, indexes, and store tests.
- **Acceptance criteria:**
  - Steps append atomically and retain deterministic ordering.
  - Interrupted runs can be marked without rewriting prior steps.
  - Retention deletes eligible trajectories and associated artifacts safely.
  - Migration tests cover fresh and existing databases.
  - Persisted payloads pass the sensitive-data filter.
- **Non-goals:** Capturing live orchestrator events or presenting them to users.

### A03 — Orchestrator trajectory adapter

- **Status:** Merged
- **PR:** [#108](https://github.com/luka-zivkovic/chvor/pull/108)
- **Dependencies:** A02
- **Outcome:** Record complete trajectories from current Chvor execution without coupling storage to the current engine.
- **Scope:** One adapter from existing execution/tool events into the canonical contract, including chat and non-chat origins.
- **Acceptance criteria:**
  - Successful, failed, aborted, approval-paused, and round-limited runs produce complete trajectories.
  - Tool inputs and results are redacted before persistence.
  - Existing WebSocket event behavior remains compatible.
  - Instrumentation failure cannot fail the user request.
- **Non-goals:** Replacing the orchestrator or changing tool-selection behavior.

### A04 — Trajectory query API

- **Status:** Merged
- **PR:** [#109](https://github.com/luka-zivkovic/chvor/pull/109)
- **Dependencies:** A03
- **Outcome:** Provide authenticated, paginated APIs for listing and inspecting trajectories.
- **Acceptance criteria:**
  - Routes enforce appropriate read scopes.
  - Filters cover session, channel, schedule, status, model, tool, and time.
  - Large bodies are represented by bounded previews or artifact references.
  - API tests cover pagination, authorization, missing runs, and redaction.
- **Non-goals:** UI, replay, mutation, or eval execution.

### A05 — Execution inspector UI

- **Status:** Merged
- **PR:** [#110](https://github.com/luka-zivkovic/chvor/pull/110)
- **Dependencies:** A04
- **Outcome:** Turn execution history into a useful per-step debugger.
- **Acceptance criteria:**
  - Users can inspect ordered steps, inputs, outputs, timing, model use, retries, approvals, and errors.
  - Sensitive values remain visibly redacted.
  - Loading, empty, partial, aborted, and failed states render correctly.
  - At least one component/integration test covers a mixed tool-and-approval trajectory.
- **Non-goals:** Editing, replaying, forking, or evaluating a run.

### A06 — Save trajectory as evaluation case

- **Status:** Merged
- **PR:** [#111](https://github.com/luka-zivkovic/chvor/pull/111)
- **Dependencies:** A05
- **Outcome:** Convert a production trajectory into a versioned local regression case.
- **Acceptance criteria:**
  - Users can choose the input, expected outcome, required/forbidden tools, and safety assertions.
  - The saved case contains no credentials or transient identifiers.
  - Cases can be exported and imported as deterministic JSON.
  - Store and API tests cover revisions and redaction.
- **Non-goals:** Running datasets or model-graded evaluation.

### A07 — Evaluation runner and comparison report

- **Status:** Merged
- **PR:** [#112](https://github.com/luka-zivkovic/chvor/pull/112)
- **Dependencies:** A06
- **Outcome:** Run datasets against a selected engine/model/prompt configuration and compare outcomes.
- **Acceptance criteria:**
  - Deterministic assertions cover completion, tool usage, approval behavior, safety, cost, and latency.
  - Runs are isolated from production side effects by a test runtime/tool layer.
  - Reports compare two configurations and retain reproducible metadata.
  - Critical evaluation failures can produce a non-zero CI result.
- **Non-goals:** Automatic prompt optimization or production self-modification.

## Track B — Understandable memory

### B10 — Context hierarchy contract

- **Status:** Merged
- **PR:** [#113](https://github.com/luka-zivkovic/chvor/pull/113)
- **Dependencies:** A03
- **Outcome:** Define explicit identity, human, working, procedural, episodic, and knowledge context layers.
- **Acceptance criteria:**
  - Each layer has ownership, mutability, visibility, budget, and precedence rules.
  - Context assembly exposes why every item was included.
  - Existing graph memories map to episodic or knowledge layers without migration loss.
- **Non-goals:** New persistence or UI.

### B11 — Structured memory blocks and revisions

- **Status:** Merged
- **PR:** [#114](https://github.com/luka-zivkovic/chvor/pull/114)
- **Dependencies:** B10
- **Outcome:** Persist bounded, versioned, user- or agent-managed memory blocks.
- **Acceptance criteria:**
  - Blocks support labels, descriptions, budgets, read-only state, confidence, provenance, verification time, and revisions.
  - Writes are auditable and restorable.
  - Migration and store tests cover concurrent updates and budget enforcement.
- **Non-goals:** Prompt injection or autonomous editing policy.

### B12 — Context assembly integration

- **Status:** Merged
- **PR:** [#115](https://github.com/luka-zivkovic/chvor/pull/115)
- **Dependencies:** B11
- **Outcome:** Assemble stable blocks, retrieved memories, history, and working state under an explicit token budget.
- **Acceptance criteria:**
  - Stable identity/human blocks do not depend on vector retrieval.
  - Budget pressure follows documented deterministic precedence.
  - Trajectories record context item references and inclusion reasons, not sensitive full contents.
  - Evaluation cases demonstrate improved recall without context overflow.
- **Non-goals:** Memory-management UI.

### B13 — Memory inspector and correction UI

- **Status:** Merged
- **PR:** [#116](https://github.com/luka-zivkovic/chvor/pull/116)
- **Dependencies:** B12
- **Outcome:** Let users inspect, edit, lock, verify, and restore what Chvor believes.
- **Acceptance criteria:**
  - Every displayed belief shows source, confidence, last verification, and revision history.
  - Users can correct or lock a block and undo changes.
  - Agent edits are clearly distinguishable from user edits.
- **Non-goals:** Shared multi-user memory or cloud synchronization.

## Track C — Trustworthy integrations

### C01 — Versioned integration manifest

- **Status:** Merged
- **PR:** [#117](https://github.com/luka-zivkovic/chvor/pull/117)
- **Dependencies:** A01
- **Outcome:** Define one declarative contract for built-in, registry, MCP, and synthesized integrations.
- **Acceptance criteria:**
  - Manifest covers ownership, version, tools, credentials, OAuth, capabilities, network/filesystem access, setup, diagnostics, and quality tier evidence.
  - Invalid or unsupported manifests fail with actionable diagnostics.
  - Existing integrations have compatibility adapters and fixtures.
- **Non-goals:** Rewriting every integration or changing credential storage.

### C02 — Manifest-driven setup and reauthentication

- **Status:** Active
- **PR:** [#118](https://github.com/luka-zivkovic/chvor/pull/118)
- **Dependencies:** C01
- **Outcome:** Use one resumable setup state machine for credentials, OAuth, discovery, reconfiguration, and reauthentication.
- **Acceptance criteria:**
  - Setup survives restart without persisting raw secrets in flow state.
  - Expired/revoked credentials enter a clear reauthentication path.
  - Duplicate account detection and explicit confirmation are tested.
  - Existing credential records migrate without re-entry where possible.
- **Non-goals:** Quality scoring or registry publishing.

### C03 — Integration diagnostics and repairs

- **Status:** Planned
- **Dependencies:** C02
- **Outcome:** Provide safe health checks and actionable repair records for integrations.
- **Acceptance criteria:**
  - Diagnostics distinguish auth, scope, rate-limit, network, schema, and provider failures.
  - Results never expose secret values.
  - Repair actions are explicit, auditable, and user-confirmed when destructive.
- **Non-goals:** Automatic credential replacement.

### C04 — Evidence-based integration quality tiers

- **Status:** Planned
- **Dependencies:** C03
- **Outcome:** Grade integrations Experimental through Platinum using machine-checkable evidence.
- **Acceptance criteria:**
  - Tier rules live in versioned data and fail CI when claimed evidence is absent.
  - Integration cards display tier, ownership, capabilities, and security summary.
  - Community integrations cannot claim a reviewed tier without passing its checks.
- **Non-goals:** Marketplace reputation or billing.

## Track D — Durable execution

### D01 — Durable wait and signal primitive

- **Status:** Planned
- **Dependencies:** A02
- **Outcome:** Persist approval, credential, OAuth, and user-input waits as resumable signals.
- **Acceptance criteria:**
  - Restarting the server does not lose a pending wait.
  - Duplicate or late signals are idempotent and audited.
  - Timeouts are persisted and recovered correctly.
  - Existing in-memory wait APIs remain compatible during migration.
- **Non-goals:** General workflow replay.

### D02 — Checkpoint and resume contract

- **Status:** Planned
- **Dependencies:** D01, A03
- **Outcome:** Resume an interrupted run from a safe checkpoint with explicit side-effect boundaries.
- **Acceptance criteria:**
  - Every external side effect has an idempotency record or is marked non-replayable.
  - Recovery summaries identify completed, pending, and failed steps.
  - Crash tests demonstrate no duplicated approved mutation.
- **Non-goals:** User-authored branch editing.

### D03 — Replay and fork

- **Status:** Planned
- **Dependencies:** D02, A05
- **Outcome:** Retry or fork from a selected checkpoint with modified input.
- **Acceptance criteria:**
  - Original history remains immutable.
  - Replayed side effects require renewed approval unless proven idempotent and policy permits reuse.
  - UI compares branch lineage and changed inputs/results.
- **Non-goals:** Arbitrary database time travel.

### D04 — Execution runtime abstraction

- **Status:** Planned
- **Dependencies:** D02
- **Outcome:** Route risky execution through a typed local, Docker, browser, or remote-PC runtime boundary.
- **Acceptance criteria:**
  - Runtime capabilities and isolation level are explicit.
  - Tool code cannot silently fall back to a more privileged runtime.
  - Cancellation, timeout, artifacts, logs, and cleanup share one contract.
  - Existing shell, sandbox, browser, and PC paths have compatibility tests.
- **Non-goals:** Introducing a microVM implementation.

## Track E — Pi engine decision

### E01 — Engine-neutral Chvor interface

- **Status:** Planned
- **Dependencies:** A03, A07, D01
- **Outcome:** Define the narrow boundary between Chvor's control plane and any agent engine.
- **Acceptance criteria:**
  - Interface covers run, stream events, steer, follow up, abort, tool execution, context, usage, and durable suspension.
  - The current engine implements it without observable behavior changes.
  - No UI, route, channel, memory, credential, or scheduler module imports a concrete engine.
- **Non-goals:** Adding Pi.

### E02 — Current-engine benchmark baseline

- **Status:** Planned
- **Dependencies:** E01
- **Outcome:** Establish the current engine's measured behavior on representative Chvor scenarios.
- **Acceptance criteria:**
  - Dataset covers conversation, multi-tool work, credential interruption, approval, failure recovery, long context, steering, schedules, memory, and fallback models.
  - Report captures completion, correctness, unsafe actions, latency, tokens, and event fidelity.
- **Non-goals:** Engine comparison or migration.

### E03 — Pi adapter spike

- **Status:** Planned
- **Dependencies:** E02
- **Outcome:** Implement Pi behind the same interface without letting Pi own Chvor persistence, permissions, or product state.
- **Acceptance criteria:**
  - Pi events map losslessly enough to render and persist canonical trajectories.
  - Chvor approval, credential, memory, and tool policies remain authoritative.
  - The same benchmark runs against both engines.
  - Package/API churn is isolated inside the adapter.
- **Non-goals:** Making Pi the default engine.

### E04 — Engine decision and optional migration

- **Status:** Planned
- **Dependencies:** E03
- **Outcome:** Record an evidence-based keep/adopt decision and, if adopted, migrate behind a feature flag.
- **Acceptance criteria:**
  - Decision record compares quality, safety, cost, latency, maintainability, and event fidelity.
  - Adoption requires explicit thresholds and rollback to the current engine.
  - Default changes only after parity and migration tests pass.
- **Non-goals:** Removing the previous engine in the same PR.

## Track F — Standard interactive tool output

### F01 — MCP Apps host boundary

- **Status:** Planned
- **Dependencies:** A05, C01
- **Outcome:** Render MCP App resources in a sandboxed host associated with their tool call and trajectory.
- **Acceptance criteria:**
  - Resource origin, permissions, CSP, lifecycle, and size limits are enforced.
  - Untrusted apps cannot access Chvor credentials, parent DOM, arbitrary network, or unrelated session data.
  - Unsupported apps degrade to a safe textual result.
- **Non-goals:** A2UI migration or marketplace distribution.

### F02 — Mediated MCP App actions

- **Status:** Planned
- **Dependencies:** F01, D01
- **Outcome:** Route app actions through typed Chvor tools, approval policy, audit, and durable signals.
- **Acceptance criteria:**
  - Every action identifies its app, tool call, session, trajectory, and requested capability.
  - Side-effect actions cannot bypass approval.
  - Replay and duplicate-action behavior is explicit and tested.
- **Non-goals:** Arbitrary iframe-to-server RPC.

### F03 — A2UI compatibility and convergence

- **Status:** Planned
- **Dependencies:** F02
- **Outcome:** Keep existing A2UI surfaces working while preferring MCP Apps for portable interactive output.
- **Acceptance criteria:**
  - A compatibility map identifies native, adaptable, and unsupported A2UI capabilities.
  - Existing surfaces have regression coverage.
  - New portable tool UIs use MCP Apps unless an explicit exception is documented.
- **Non-goals:** Immediate deletion of A2UI.

## Completion gate

The platform-evolution goal is complete only when:

- Every non-superseded batch above is merged and verified on `main`.
- The execution inspector exposes durable, redacted trajectories and evaluation capture.
- Memory is structured, explainable, revisioned, and correctable.
- Integrations use manifests, resumable setup/reauthentication, diagnostics, and evidence-backed quality tiers.
- Human waits and execution checkpoints survive restart; safe replay/fork is available.
- The Pi decision is documented with benchmark evidence and any adoption is reversible.
- MCP Apps execute through Chvor's sandbox, permission, approval, and audit boundaries.
- Cross-cutting migration, backup/restore, security, packaging, and documentation audits pass.
