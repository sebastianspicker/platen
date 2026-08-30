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

`npm run report` reads the checked-in capability, proof, and prototype
catalogs and prints a concise status summary.

On macOS, `npm run verify` builds the PDFKit package before running Node tests.
Native build failures must be resolved or reported as native toolchain failures,
not silently skipped. Optional document engines may be absent, but every
unavailable path must remain explicit and fail closed.

## Change-specific evidence

- Capability delivery changes require runtime behavior, bounded failures,
  deterministic fixtures, and output validation.
- Host layer changes require the architecture-import-boundaries coverage in
  addition to authentication, cancellation, cleanup, and no-clobber publication
  checks where applicable. Preserve root -> bootstrap -> transport/http ->
  application -> platform imports; platform must not import application.
- Browser and CLI changes require their separate-adapter boundaries to remain
  intact: browser code must not import host implementations, and CLI behavior
  must use the composed local application.
- Browser changes require keyboard and narrow-layout checks in addition to unit
  coverage.
- Catalog, schema, runtime-contract, and release-inventory changes require
  `npm run release:validate`.

Keep generated build state and private document fixtures out of the release
inventory.
