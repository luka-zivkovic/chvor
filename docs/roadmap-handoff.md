# Platform Evolution Handoff

This file is the durable bootstrap context for a new agent session. Repository state, merged pull
requests, and [`platform-evolution-batches.md`](./platform-evolution-batches.md) are authoritative;
conversation history is not.

## Delivery contract

Work on one independently releasable batch at a time:

1. Verify the previous batch is merged and `main` is clean and current.
2. Confirm scope, dependencies, acceptance criteria, and non-goals in the roadmap.
3. Create a dedicated branch from `main`.
4. Implement only that batch, including proportional tests and documentation.
5. Run type, test, build, lint, formatting, and line-limit checks as applicable.
6. Review the complete diff for correctness, security, concurrency, migration compatibility, and
   unnecessary scope.
7. Open a pull request, wait for CI and review, resolve every actionable finding, and re-verify.
8. Merge, sync `main`, and verify it before selecting the next batch.

Never implement the next batch before the current pull request is merged.

## Current boundary

- Tracks A (inspectable execution/evaluation) and B (understandable memory) are complete.
- C01, the versioned integration manifest, merged in
  [PR #117](https://github.com/luka-zivkovic/chvor/pull/117).
- C02, manifest-driven setup and reauthentication, merged in
  [PR #118](https://github.com/luka-zivkovic/chvor/pull/118).
- The next eligible batch is **C03 — Integration diagnostics and repairs**.

At the C02 review boundary, the full repository verification passed: 1,261 tests passed, one test
was skipped, typecheck and build passed, lint had zero errors and 124 baseline warnings, the
1,000-line limit passed, and the staged diff passed Git whitespace checks. A final review finding
about the public V1 credential-field schema alias was fixed with a focused regression test.

## Architectural decisions to preserve

- Chvor owns persistence, permissions, auditability, product state, and user-facing policy.
- Agent engines are replaceable adapters; Pi is evaluated later through benchmarks, not adopted by
  default or allowed to become the control plane.
- Trajectories, memory blocks, integration manifests, and setup flows are versioned contracts.
- Integration setup and OAuth state are durable and optimistic-concurrency controlled.
- Raw secrets do not belong in setup-flow snapshots, logs, manifests, diagnostics, or handoff files.
- Credential authorization is enforced again immediately before runtime use.
- Manifest and OAuth identity references resolve exactly and fail closed; no fuzzy fallback is
  allowed when a versioned reference is present.
- Destructive repair, replay, and app actions remain explicit, auditable, and approval-aware.

## Strategy and sequence

Read [`inspiration-projects.md`](./inspiration-projects.md) for strategic rationale. The intended
remaining sequence is:

1. C03 integration diagnostics and repairs
2. C04 evidence-based integration quality tiers
3. D01 durable wait and signal primitive
4. D02 checkpoint and resume contract
5. D03 replay and fork, then D04 execution runtime abstraction
6. E01–E04 engine-neutral interface, current-engine baseline, Pi spike, and evidence-based decision
7. F01–F03 MCP Apps host/actions and A2UI convergence

Dependencies in the roadmap remain authoritative if this sequence changes.

## New-session bootstrap

Start by running:

```bash
git status --short
git branch --show-current
git log --oneline --decorate -10
/Users/makina/Library/Application\ Support/com.jean.desktop/gh-cli/gh pr status
```

Then read this file, the roadmap, the inspiration research, and the latest merged PR before creating
a goal for the remaining roadmap.

Suggested prompt:

> Continue Chvor's platform-evolution roadmap. Treat `docs/roadmap-handoff.md`,
> `docs/platform-evolution-batches.md`, merged pull requests, and current Git state as the source of
> truth. Verify C02 PR #118 is merged and sync a clean `main`. Then create a goal for the remaining
> roadmap and execute one strict
> branch/PR/review/merge batch at a time, starting with C03. Preserve the documented architectural
> invariants and do not begin a later batch before the current batch is merged.
