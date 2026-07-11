# Execution inspector

A05 adds a read-only **Executions** panel to the desktop and mobile navigation. It consumes the
authenticated trajectory API from A04; it does not mutate, replay, fork, or evaluate runs.

## Inspector behavior

- The left rail lists trajectories newest-first and supports status filtering and cursor-based
  pagination.
- Selecting a trajectory loads its canonical detail and orders timeline steps by sequence.
- Bounded API preview envelopes are rendered verbatim so they cannot be confused with ordinary
  user payload objects that happen to contain preview-like field names.
- The header shows origin, actor, status, start time, total duration, model usage, and top-level
  errors.
- Step cards expose inputs, outputs, timing, model/token use, retryable failures and fallbacks, tool
  identity and credential references, approval decisions, errors, attributes, and artifact refs.
- Execution-level attempt metadata is shown for retrying webhook and similar ingress flows.
- Running, waiting, and pending trajectories are explicitly marked as partial. Completed, failed,
  aborted, and round-limited states retain distinct status treatment.

## Sensitive and large values

The inspector only renders the already-redacted trajectory API response. `[REDACTED]` markers stay
visible and receive warning emphasis. Payloads larger than the API bounds remain previews and show
their original byte count; the client never attempts to fetch or reconstruct omitted body data.

## Failure states

List and detail requests have independent loading, empty, error, and retry states. A stale request
cannot overwrite a newer status filter or trajectory selection.
