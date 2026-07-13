# Versioned integration manifests (C01)

The integration manifest is Chvor's canonical, declarative description of an
integration. It normalizes built-in providers, registry and user tools, MCP
servers, and synthesized HTTP tools without replacing their existing runtimes or
credential records.

## Version and validation boundary

`schemaVersion` identifies the manifest schema and is independent from the
integration's strict semantic `version` and the registry-index version. Chvor
supports schema version 1. Unknown fields, unsupported versions, unknown security
enums, invalid references, and malformed access declarations fail closed with
structured, bounded diagnostics. Diagnostics contain a stable code, severity,
field path, safe message, and optional remediation hint; they never include
credential values or request bodies.

Compatibility adapters are pure and deterministic. They read existing metadata,
produce normalized manifests and warnings, and never spawn MCP processes, perform
network requests, read credential values, or rewrite legacy source files. One bad
legacy entry does not prevent diagnostics for the remaining entries.

`GET /api/integrations/manifests` resolves the initialized, deduplicated active
tool snapshot, so bundled native tools, installed registry tools, user MCP tools,
and synthesized tools share the same response contract. The request path performs
no capability-directory scans or migrations; it returns an actionable `503` if
startup has not initialized the snapshot yet.

## Security semantics

Manifests contain credential types and field metadata only. They must not contain
credential IDs, encrypted blobs, tokens, passwords, authorization headers,
cookies, or private keys. Credential fields have an explicit sensitivity kind;
legacy fields default to secret unless an adapter can prove a safer type.

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
