# Versioned integration manifests (C01)

The integration manifest is Chvor's canonical, declarative description of an
integration. It normalizes built-in providers, registry and user tools, MCP
servers, and synthesized HTTP tools without replacing their existing runtimes or
credential records.

## Version and validation boundary

`schemaVersion` identifies the manifest schema and is independent from the
integration's strict semantic `version` and the registry-index version. Chvor
reads schema versions 1 and 2 and emits schema version 2. Version 1 remains the
original strict contract; in particular, its credential fields do not accept a
`storageKey` or a direct-OAuth `provider`. Version 2 adds the optional
credential-field `storageKey` mapping and requires an explicit provider on each
direct OAuth declaration.
Unknown fields, unsupported versions, unknown security enums, invalid references,
and malformed access declarations fail closed with structured, bounded
diagnostics. Diagnostics contain a stable code, severity, field path, safe
message, and optional remediation hint; they never include credential values or
request bodies.

Compatibility adapters are pure and deterministic. They read existing metadata,
produce normalized manifests and warnings, and never spawn MCP processes, perform
network requests, read credential values, or rewrite legacy source files. One bad
legacy entry does not prevent diagnostics for the remaining entries.

Legacy declarations without an independent version use `0.0.0` only inside their
compatibility adapter. At final catalog resolution, Chvor hashes the canonical
normalized manifest with SHA-256 and publishes a SemVer build-metadata version in
the form `0.0.0+sha256.<base36-digest>`. Equal manifest content therefore keeps a
stable version, while a semantic content change produces a different version.
Declarations that explicitly provide a version, including an explicit `0.0.0`,
are published unchanged.

`GET /api/integrations/manifests` resolves the initialized, deduplicated active
tool snapshot, so bundled native tools, installed registry tools, user MCP tools,
and synthesized tools share the same response contract. The request path performs
no capability-directory scans or migrations; it returns an actionable `503` if
startup has not initialized the snapshot yet.

The resumable consumer of these declarations is documented in
[Manifest-driven integration setup](./integration-setup.md).

Current direct OAuth declarations carry an explicit built-in provider
identifier. The setup client and server use that field rather than deriving
authorization behavior from a manifest-ID naming convention; legacy v1 direct
OAuth declarations without it fail closed in the setup runtime. Catalog rows likewise include
the exact active manifest ID, version, and credential declaration when
manifest-driven setup is available; clients fail closed on stale references.

## Security semantics

Manifests contain credential types and field metadata only. They must not contain
credential IDs, encrypted blobs, tokens, passwords, authorization headers,
cookies, or private keys. Credential fields have an explicit sensitivity kind;
legacy fields default to secret unless an adapter can prove a safer type. A
field may also declare a bounded `storageKey` so normalized manifest IDs such as
`client-id` still map to the runtime's established key such as `clientId`. This
mapping is available only in schema version 2; version 1 readers and documents
retain their original strict shape.

Access declarations describe requested access and its enforcement level. They do
not grant access and must not imply sandboxing that the current runtime does not
provide. In particular, legacy stdio MCP servers are represented pessimistically
as same-user process execution with advisory broad network, filesystem, and
environment access. Synthesized HTTPS tools retain their stricter runtime network
policy, while manifests remain descriptive rather than an authorization bypass.

## Compatibility and scope

Existing provider, catalog, credential, OAuth, registry, MCP, and synthesized APIs
remain compatible during C01. The normalized manifest API is additive. Setup
steps and diagnostic checks are declarations for later C02/C03 consumers; C01
does not introduce a setup state machine or repair execution.

Quality data separates the claimed tier from evidence records. Legacy adapters
default to `experimental`; registry integrity and OpenAPI verification can be
recorded as evidence but cannot independently create a reviewed quality claim.
Machine-checkable tier rules and integration-card presentation belong to C04.

## Deliberate non-goals

C01 does not rewrite integrations, alter credential encryption or storage, launch
or sandbox MCP servers, migrate stored credentials, implement reauthentication,
execute repairs, or calculate marketplace quality/reputation. Unregistered legacy
integration modules are not advertised as executable tools.
