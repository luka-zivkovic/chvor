# Evaluation runs and comparison reports

Chvor evaluation runs execute saved evaluation-case revisions against an explicit model and prompt configuration. Every completed report snapshots the case documents, prompt, simulated tool catalogue, pricing, limits, runtime metadata, and hashes needed to reproduce or compare the run.

## Isolation boundary

Evaluation runs do **not** call the production orchestrator or production tool runner.

The server resolves only the selected model credential, then starts a dedicated child process with a sanitized environment. The child can contact the selected model provider, but it does not import Chvor's database, memory, MCP manager, native tools, browser, shell, PC control, approvals, audit log, scheduler, or production tool graph.
The isolated engine accepts fixed-endpoint cloud providers and explicit loopback-only local model
providers. Arbitrary custom provider URLs are intentionally unsupported so an `evaluation:run`
scope cannot become a network-probing or redirect-based SSRF capability.

All tools are deterministic stubs:

- `effect` records whether the simulated action is a read or write.
- `approval` is either `auto-approve` or `auto-deny`.
- Approved calls return the configured redacted JSON fixture.
- Denied calls return a synthetic denial.
- Even an approved write never reaches a real system or provider.

This is a regression-test runtime, not a disposable-account integration-test runtime.

## Runnable case inputs

A saved A06 case can run when `input` is one of:

- a non-empty string;
- `{ "prompt": "..." }`;
- an array of `{ role, content }` text messages;
- `{ "messages": [...] }` with the same message shape.

Other arbitrary JSON remains valid for storage/export, but the runner rejects it before a model call.

## Assertions

Reports contain deterministic assertion rows for configured expectations:

- terminal completion status;
- exact output and literal output substrings;
- required and forbidden tool attempts;
- required approval behavior;
- raw-result secret detection before persisted redaction;
- unapproved write-tool execution;
- per-case cost and latency limits.

An unavailable cost measurement fails the configured cost gate. A report's CI gate passes when every critical case passes; non-critical failures remain visible without failing the report.
Exact output comparisons preserve JSON types. Cases captured from Chvor trajectories store a
structured `ConversationResult`; the isolated text engine compares that known envelope's `text`
field while retaining the complete captured object in the immutable case snapshot.

## API

All responses use `Cache-Control: no-store`. API keys need `evaluation:read` to browse reports and `evaluation:run` to create one.

| Method | Path                                                  | Purpose                                                                     |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST` | `/api/evaluation-runs`                                | Run 1–100 saved case revisions and atomically persist the completed report. |
| `GET`  | `/api/evaluation-runs`                                | List bounded report summaries with an opaque keyset cursor.                 |
| `GET`  | `/api/evaluation-runs/:id`                            | Read a complete bounded report.                                             |
| `GET`  | `/api/evaluation-runs/:id/cases`                      | Page normalized case results in stable position order.                      |
| `GET`  | `/api/evaluation-runs/:id/cases/:position`            | Read one case result.                                                       |
| `GET`  | `/api/evaluation-runs/compare?baseline=…&candidate=…` | Compare paired case snapshots, cost, and latency.                           |

The run request contains saved case IDs/revisions and a configuration without credentials. Every required or forbidden tool named by a case must have a deterministic stub in `configuration.tools`.

```json
{
  "cases": [{ "id": "case-id", "revision": 2, "critical": true }],
  "configuration": {
    "engineId": "chvor-isolated-v1",
    "providerId": "openai",
    "modelId": "model-id",
    "prompt": "Complete the input safely.",
    "temperature": 0,
    "maxRounds": 4,
    "caseTimeoutMs": 120000,
    "pricing": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2
    },
    "limits": {
      "maxCostUsdPerCase": 0.05,
      "maxLatencyMsPerCase": 30000
    },
    "tools": [
      {
        "name": "native__web_search",
        "description": "Deterministic search fixture",
        "effect": "read",
        "approval": "auto-approve",
        "result": { "results": ["fixture"] }
      }
    ]
  }
}
```

## CLI and CI

Run saved IDs directly:

```bash
chvor eval run --case <case-id> --provider openai --model <model-id> \
  --tool-stubs ./evaluation-tools.json \
  --max-cost 0.05 --input-price 1 --output-price 2 --json
```

Portable case files can be positional arguments. The CLI imports them first and then runs their saved IDs.

```bash
chvor eval run ./cases/refusal.evaluation.json \
  --provider openai --model <model-id> --tool-stubs ./evaluation-tools.json
```

Compare reports:

```bash
chvor eval compare <baseline-run-id> <candidate-run-id> --json
```

Use `--url`/`CHVOR_URL` for the API base URL and `--token`/`CHVOR_TOKEN` for a bearer token. The CLI
uses the saved installation token only for its exact default local API URL; overridden URLs require
an explicit token.
Cost gates require explicit `--input-price` and `--output-price` USD-per-million snapshots so
the report remains reproducible when provider pricing changes.

Exit codes:

- `0`: configured gate passed;
- `1`: a critical case failed, an assertion was unavailable, or a comparison regressed;
- `2`: configuration, authentication, transport, or runner failure;
- `130`: interrupted.

JSON is written to stdout; diagnostics are written to stderr.

## Persistence and comparison

Migration v34 stores immutable run metadata and normalized immutable case rows. Lists and case results are bounded to 20 rows per page. Full reports are bounded to 100 cases and 8 MiB. Stored credentials and raw secret matches are never part of the report schema.

Comparison pairs cases by saved case ID, revision, and canonical document hash. It reports regressions, improvements, unchanged outcomes, baseline-only/candidate-only cases, and nullable cost/latency deltas.
