# Architecture

Platen is a local modular monolith. Browser and CLI adapters use one composed
local application; sources remain immutable and operations publish separately
validated artifacts. Optional native helpers stay behind platform adapters.

## Host layers

```text
root entrypoints -> bootstrap -> transport/http -> application -> platform
```

| Layer | Location | Responsibility | May import |
| --- | --- | --- | --- |
| Root | `src/host/main.mjs`, `src/host/local-host.mjs` | Start the loopback process and expose host startup. | root, bootstrap |
| Bootstrap | `src/host/bootstrap/` | Compose concrete services, stores, runners, adapters, and handlers. | bootstrap, transport, application, platform |
| Transport | `src/host/transport/http/` | Loopback HTTP, static files, routes, request parsing, token/origin/method checks, and responses. | transport, application, platform |
| Application | `src/host/application/` | Feature behavior: automation, capabilities, documents, domains, OCR, PDF, plugins, prepress, review, and security. | application, platform |
| Platform | `src/host/platform/` | Runtime, storage, local executable, and native-helper boundaries. | platform only |

Application feature areas may depend on other application areas. Platform must
not import application. The architecture-import-boundaries test enforces these
directions and keeps concrete runtime construction in bootstrap.

## External adapters and contracts

- `src/browser/` is a browser adapter. It owns browser state, rendering, and
  loopback API clients. All endpoint factories live in `src/browser/api/`; it
  does not import host implementations.
- `src/cli/` is a CLI adapter. It owns parsing, dispatch, and no-clobber output
  publication, then uses the composed local application without starting the
  HTTP server. Its bounded `application.cli` facade owns document, artifact,
  input, provenance, and shutdown access, so commands never reach into concrete
  platform stores.
- `src/contracts/` is neutral runtime validation and shared request/result,
  error, and value definitions. It imports no browser, host, CLI, native, or
  platform-adapter implementation.
- `schemas/` validates checked-in catalog and record data. It is separate from
  runtime contracts.

```text
browser -> loopback HTTP -> transport/http -> application -> platform
CLI -> host root/bootstrap and inward-facing application contracts
```

## Registries

Two application modules provide bounded data-driven dispatch:

- `application/domains/domain-operation-registry.mjs` exposes a closed set of
  group/operation pairs and routes validated JSON to the domain facade.
- `application/capabilities/capability-delivery-registry.mjs` exposes a closed
  set of professional capability handlers after dedicated CLI entrypoints are
  excluded.

Both registries are fixed allowlists. They do not support runtime registration,
reflection, arbitrary method names, executable user code, or third-party
plugins. They are dispatch boundaries, not a claim that every domain operation
has an independent module or deployment boundary.

## Change placement

- Compose concrete collaborators in `src/host/bootstrap/`.
- Put HTTP and static-file behavior in `src/host/transport/http/`.
- Put feature behavior in its owning `src/host/application/` area.
- Name state-aware request validation `*-admission.mjs`; import canonical wire
  identifiers from the paired neutral contract rather than redeclaring them.
- Put filesystem, process, executable, and native-helper integration in the
  appropriate `src/host/platform/` area.
- Put browser and CLI behavior in their separate adapters; put neutral shapes
  and validation in `src/contracts/`.

Preserve CLI, HTTP, native-protocol, schema, and runtime-contract compatibility
unless a change declares and tests a revision.
