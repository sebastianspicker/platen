# Releasing

This process prepares a public alpha. It does not authorize a commit, push, tag,
GitHub release, or artifact publication.

## Candidate identity

The current candidate is `0.3.0-alpha.1`. Keep these files aligned:

- `package.json`
- `scripts/release/validate-current-release.mjs`
- `README.md`
- `RELEASE_STATUS.md`
- `CHANGELOG.md`
- `docs/releases/0.3.0-alpha.1.md`

## Local gate

From a trusted, quiescent checkout:

```sh
npm test
npm run verify
npm run check:professional-clones
npm run release:validate
npm run report
```

A passing `release:validate` receipt includes a deterministic local
source-inventory SBOM, but it remains local evidence only. `distributionStatus`
stays `not-ready` until release authority selects source-only or packaged-macOS
distribution and retains candidate provenance plus the applicable signing and
notarization evidence or explicit not-applicable decision.

## Publication checklist

1. Confirm the exact file set for the first public commit or tag.
2. Enable private security reporting on the target GitHub repository.
3. Re-read [SECURITY.md](../SECURITY.md) and residual risk tables.
4. Confirm screenshots under `docs/screenshots/` match `manifest.json`.
5. Tag and publish only under explicit release authority.

## After publication

- Record the tag and commit in `CHANGELOG.md`.
- Update [RELEASE_STATUS.md](../RELEASE_STATUS.md) with the published identity
  and remaining distribution blockers.
