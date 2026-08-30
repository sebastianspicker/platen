# Documentation

Start with the root [README](../README.md) for requirements, local startup, and
the alpha boundary.

## Architecture and maintenance

- [Architecture](architecture.md) describes the physical host layers, dependency
  direction, external adapters, and side-effect boundaries.
- [ADR 0001](decisions/0001-modular-monolith-contracts-bootstrap.md) records the
  modular-monolith, neutral-contract, and bootstrap decision.
- [ADR 0002](decisions/0002-bounded-runtime-registries.md) bounds the two
  closed allowlisted dispatch registries used by existing UI and CLI contracts.
- [Workbench operations](operations.md) summarizes immutable sources,
  derived artifacts, local engines, and cancellation expectations.
- [Maintenance checks](maintenance-checks.md) lists the routine local commands.

## Product and release

- [Capability coverage](capability-coverage.md) defines evidence and limits for
  implemented and constrained capability records.
- [Frontend](FRONTEND.md) covers browser structure, accessibility, and manual
  QA still required.
- [Releasing](RELEASING.md) defines the local candidate gate and the separate
  publication authority boundary.
- [Research sources](research-sources.md) records catalog provenance.

Root-level [SECURITY](../SECURITY.md), [CONTRIBUTING](../CONTRIBUTING.md), and
[CHANGELOG](../CHANGELOG.md) cover reporting, contribution, and version history.
