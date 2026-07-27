# Release status

Candidate: `0.3.0-alpha.1`

Status date: 2026-07-24

The tree is a public-alpha candidate. It is not a published release. Local
validation does not authorize a tag, GitHub release, or distribution package.

## Required before public alpha

- Establish Git provenance for the exact first-publication file set.
- Configure the GitHub repository and a private security contact.
- Run the release checklist against the commit intended for tagging.
- Review a clean checkout for generated files, local tool state, secrets, and
  machine-specific paths.
- Confirm repository ownership and release authority before any push or tag.

## Recommended before public alpha

- Re-capture screenshots with a maintained, fixture-only capture path.
- Complete keyboard, screen-reader, contrast, zoom, touch, cancellation, and
  recovery checks recorded in `docs/FRONTEND.md`.
- Validate on another macOS system and one non-macOS system with documented
  optional engines.

## Acceptable alpha limitations

- Optional engines can be unavailable independently.
- Browser-native PDF rendering varies by browser.
- Third-party plugin installation and execution remain disabled.
- Catalog `ai.*` entries remain excluded from implementation.
- Local release validation reports `distributionStatus: not-ready` until
  signing, notarization, and SBOM evidence exist.

## Current local evidence

Run from a trusted checkout:

```sh
npm test
npm run verify
npm run release:validate
npm run report
```

`npm run release:validate` produces a local inventory receipt. It does not
establish distribution trust.
