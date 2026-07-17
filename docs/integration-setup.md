# Manifest-driven integration setup (C02)

Chvor uses one durable state machine for credential setup, OAuth, discovery,
reconfiguration, and reauthentication. A flow is always pinned to an active C01
integration manifest and its exact version. The flow records progress and safe
references; credential material remains in the encrypted credential store or a
short-lived encrypted OAuth envelope.

Unversioned legacy declarations receive a deterministic content-derived SemVer
build identifier when the active catalog is resolved. As a result, changing
their normalized setup, credential, OAuth, tool, access, or diagnostic semantics
changes the active manifest version. Resume and mutation reject an older flow
whose pinned version no longer matches rather than continuing under changed
metadata. Explicit source versions remain authoritative and unchanged.

## State and restart behavior

Each flow has a stable ID, optimistic `revision`, mode, authentication status,
expiry, current step, and durable step journal. The selected manifest/app
credential (`targetCredentialId`) and OAuth account token
(`oauthCredentialId`) are separate safe references. Mutations must include the
latest flow ID and revision. A stale mutation returns a conflict rather than
silently replacing newer progress; clients recover by fetching the current
snapshot and asking the user to retry when input is still required.

The public flow states are:

- `awaiting-input` for manifest instructions or credential fields;
- `awaiting-oauth` while an authorization window is open;
- `awaiting-confirmation` when matching credentials require an explicit choice;
- `discovering` while safe account metadata is being resolved; and
- `completed`, `failed`, `cancelled`, or `expired` for terminal flows.

The UI may retain a flow ID so setup resumes after a reload or server restart. It
must not put credential field values, OAuth codes, PKCE values, tokens, or client
secrets in browser storage. Terminal flow IDs are removed.

Before starting a new flow, the UI persists a client-generated idempotency key
scoped to the exact setup identity and sends it with the start request. The
server reuses that key as the flow ID and durably binds it to a SHA-256 digest of
the complete start metadata. Exact retries return the existing snapshot;
reusing a key with different metadata fails closed. This prevents overlapping
mount effects or a lost response from creating duplicate flows, without storing
credential values in the browser or the idempotency journal.

## Secret boundary

Raw credential submissions are request-only. They are validated against the
manifest declaration and written directly to the existing AES-GCM credential
store. They are never copied into flow rows, step rows, responses, diagnostics,
logs, duplicate summaries, or account fingerprints.

For in-place reconfiguration, the flow stores only a SHA-256 digest of the
credential row's opaque ciphertext as its durable compare-and-swap version.
The ciphertext itself remains solely in the credential store; the current row
must match the digest and still win the credential-store CAS before an update
can commit.

Direct and synthesized OAuth requests keep PKCE and provider configuration in a
bounded, expiring AES-GCM envelope. Only a SHA-256 digest of the random OAuth
state is indexed. Callback state is one-time: the envelope is deleted when it is
consumed and expired envelopes are rejected. Authorization codes are exchanged
in memory and are not persisted.

Account fingerprints are one-way hashes scoped to the integration. OAuth
fingerprints use bounded provider account identity when the token response
supplies it; generic credentials use declared non-secret identity fields when
available. Public duplicate candidates contain only credential ID, display
name, type, an optional bounded account label, and the safe decisions currently
allowed for that candidate. Expired or manifest-stale OAuth accounts can be
replaced but are never offered for reuse without fresh authorization.

## Duplicate and migration behavior

Setup never silently overwrites the first credential of a matching type. When
existing records are candidates, the user explicitly chooses one action:

- **Reuse existing** adopts the chosen record without asking for its secret;
- **Replace existing** keeps the chosen credential ID and updates it with the
  newly submitted values;
- **Create additional** creates a distinct credential; or
- **Cancel** terminates the flow without changing a credential.

OAuth account candidates are confirmed before PKCE authorization whenever they
are already known. Reuse advances with the exact active account, replace keeps
that OAuth credential ID for the callback update, and create-additional records
an explicit safe decision before a new account is authorized. If an account
appears concurrently only after token exchange, the exchanged values are
discarded and the flow pauses for confirmation before a fresh authorization
attempt.

Adoption creates a manifest binding lazily and leaves the existing encrypted
credential bytes untouched. Reconfiguration and reauthentication target a
specific credential ID, preserving session pins and references whenever the
credential can be updated in place. Database migration v36 is schema-only and
does not decrypt, rewrite, or contact providers for existing credentials.

## Reauthentication

Credential bindings track `unknown`, `active`, `expired`, `revoked`,
`reauthentication-required`, or `failed`. Successful OAuth exchange or refresh
marks a binding active and clears stale failure metadata. Terminal provider
responses such as a revoked refresh grant mark the binding
`reauthentication-required`; transient network and provider failures do not.

Connection lists surface this status so the UI can offer **Reauthenticate**.
Reauthentication is an ordinary manifest-driven flow with exact app/setup and
OAuth account targets, not a special destructive replacement path. Runtime
credential resolution rejects blocked bindings before secrets are injected or
a synthesized request is sent. Cached MCP connections repeat that check before
dispatch and are recycled when the selected credential's ciphertext version
changes, so a long-lived process cannot keep using superseded credentials.

OAuth refreshes are serialized per credential with an expiring database lease
in addition to compare-and-swap writes. This coordinates multiple server
processes: contenders wait for the lease holder and use the rotated ciphertext
instead of redeeming the same refresh token again.

## HTTP API

All successful endpoints use the standard `{ "data": ... }` envelope. Mutation
bodies are strict and versioned; unknown fields are rejected.

| Method | Path                                     | Purpose                                                      |
| ------ | ---------------------------------------- | ------------------------------------------------------------ |
| `POST` | `/api/integration-setup`                 | Validate the active manifest and start a flow                |
| `GET`  | `/api/integration-setup`                 | List bounded recent flow snapshots                           |
| `GET`  | `/api/integration-setup/:id`             | Resume one flow                                              |
| `POST` | `/api/integration-setup/:id/credentials` | Submit request-only credential fields                        |
| `POST` | `/api/integration-setup/:id/acknowledge` | Explicitly acknowledge the current instruction               |
| `POST` | `/api/integration-setup/:id/confirm`     | Resolve duplicate candidates explicitly                      |
| `POST` | `/api/integration-setup/:id/discovery`   | Ask the server to derive the current declarative setup check |
| `POST` | `/api/integration-setup/:id/cancel`      | Cancel a non-terminal flow                                   |

The server validates that the URL ID, body flow ID, manifest ID/version,
credential declaration, credential type, target record, current step, status,
and revision agree before applying a mutation. Safe machine-readable error codes
distinguish validation, missing flow, conflict, expiry, and illegal transition.

## Operational notes

- Flow and OAuth envelope expiry is enforced on reads and transitions; cleanup is
  safe to repeat. Every terminal transition purges the flow's remaining
  encrypted envelopes.
- Removing a credential also removes its manifest binding through foreign-key
  cascade. It does not rewrite completed flow history.
- OAuth callback pages post only safe flow/connection correlation metadata to
  their opener. Initiation returns the configured callback origin; clients
  verify that origin, popup source, exact flow, account target, and attempt.
- Set `CHVOR_APP_ORIGIN` to the UI's exact HTTP(S) origin (for example,
  `https://app.example.com`, with no path or trailing slash) when the UI and
  OAuth callback use different origins. If it is unset, the callback origin is
  used as the safe `postMessage` target; invalid explicit values make OAuth
  initiation fail rather than falling back to a wildcard target.
- C02 does not run C03 health diagnostics, automatic repairs, quality scoring,
  registry publishing, or marketplace review.
