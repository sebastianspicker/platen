# Documentation

Start with the root [README](../README.md) for installation, supported engines,
and the public-alpha scope.

## Product and engineering

- [Architecture](architecture.md) describes runtime boundaries, data flow, and
  the disabled third-party plugin boundary.
- [Capability coverage](capability-coverage.md) defines the evidence required
  for an implemented capability and documents narrow alpha subsets.
- [Feature-gap report](feature-gap-report.md) is generated from the capability
  catalogs. Regenerate it with `npm run report:write`.
- [Frontend](FRONTEND.md) records the browser application structure,
  accessibility contract, and manual QA still required.
- [Workbench operations](workbench-notes.md) summarizes source, artifact, and
  cancellation behavior for maintainers.

## Maintenance and release

- [Maintenance checks](maintenance-checks.md) lists routine deterministic
  repository checks.
- [Release checks](release-checks.md) defines the local candidate gate and its
  limits.
- [Releasing](RELEASING.md) contains the publication procedure.
- [Release notes](release-notes.md) points to the authoritative versioned notes
  and changelog.
- [Operations follow-up](operations-followup.md) lists manual and external work
  that local verification cannot close.

Historical material under `archive/` is not current product documentation.
