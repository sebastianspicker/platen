# Maintenance checks

Use the smallest check that covers the change, then run the broad gate before a
release candidate.

## Routine checks

```sh
npm test
npm run verify
npm run report
npm run check:professional-clones
```

Run `npm run report:write` only when capability catalog changes intentionally
alter the generated report. Review the resulting diff; do not edit generated
counts by hand.

On macOS, `npm run verify` builds the PDFKit and plugin-worker packages before
running Node tests. Native build failures must be resolved or reported as native
toolchain failures, not silently skipped. Optional document engines may be
absent, but every unavailable path must remain explicit and fail closed.

## Change-specific evidence

- Capability delivery changes require runtime behavior, bounded failures,
  deterministic fixtures, and output validation.
- Host or CLI changes require authentication, cancellation, cleanup, and
  no-clobber publication checks where applicable.
- Browser changes require keyboard and narrow-layout checks in addition to unit
  coverage.
- Catalog, contract, and release-inventory changes require
  `npm run release:validate`.

Keep generated build state and private document fixtures out of the release
inventory.
