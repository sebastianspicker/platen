# ADR 0001: Modular monolith with neutral contracts and explicit composition

## Status

Accepted.

## Context

Platen is one local workbench that keeps immutable sources, private storage,
validation, and derived-artifact publication coherent for browser, CLI, local
engines, and optional native helpers.

## Decision

Keep one modular Node host with these physical layers: root entrypoints,
`bootstrap/`, `transport/http/`, `application/`, and `platform/`. Bootstrap is
the composition root. It selects concrete platform collaborators, application
services, and HTTP handlers. Application areas may collaborate; platform owns
runtime, storage, and adapters and may not import application.

Keep `src/contracts/` neutral. Browser and CLI remain separate adapters: the
browser uses the loopback API, while the CLI uses the same composed local
application without starting a server. A bounded CLI facade owns storage,
provenance, and shutdown access. Public wire identifiers live in neutral
contracts; state-aware host validation lives in paired `*-admission.mjs`
modules that import those canonical identifiers.

## Consequences

The codebase keeps direct local calls and one source/artifact lifecycle.
Bootstrap makes concrete dependency choices visible, platform isolates real I/O,
and tests can replace boundary collaborators without inventing interfaces for
every in-process call.

## Alternatives rejected

- Microservices: they would turn local calls into network protocols while still
  sharing one user, store, and artifact lifecycle.
- A general command bus: explicit routes and CLI dispatch retain
  operation-specific validation, cancellation, and error behavior. The two
  bounded registries are governed by ADR 0002.
- Full ports-and-adapters layering: only platform integration and HTTP transport
  require that level of indirection; making every application call a port would
  obscure local behavior without an independent deployment boundary.
