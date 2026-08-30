# ADR 0002: Closed allowlisted application registries

## Status

Accepted.

## Context

The workflow UI accepts a bounded domain group/operation request, and one CLI
surface dispatches selected professional capability IDs. Duplicating those
selection steps across route or parser branches would not remove the dynamic
contract.

## Decision

Keep two fixed application-layer registries:

- `src/host/application/domains/domain-operation-registry.mjs` publishes the
  allowed domain group/operation pairs, bounds JSON input, and calls the
  appropriate service through its local domain facade.
- `src/host/application/capabilities/capability-delivery-registry.mjs` maps
  allowed professional capability IDs to handlers after reserved dedicated CLI
  entrypoints are rejected.

Neither registry permits runtime registration, arbitrary method names,
reflection, executable user code, or third-party plugin dispatch. Handler
presence is not proof of a catalog claim, and the registries do not imply that
each domain behavior is an independently deployable or separately modular
component.

## Consequences

New dedicated HTTP or CLI surfaces should call their owning application service
directly. A registry addition must preserve bounded input, failure behavior,
and relevant tests and capability evidence. The registries must not become
platform dependencies or extension points.
