# Releasing

This process prepares a public alpha. It does not authorize a commit, push, tag,
GitHub release, or artifact publication.

## Candidate identity

The current candidate is `0.3.0-alpha.1`. Keep these files aligned:

- `package.json`
- `tools/release/validate-current-release.mjs`
- `README.md`
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

A passing `release:validate` receipt requires a clean Git worktree and includes
a deterministic local source and runtime-stylesheet inventory SBOM, but it remains local evidence
only. This prevents untracked replacement files or tracked deletions from being
mistaken for a reproducible candidate. `distributionStatus` stays `not-ready`
until release authority selects source-only or packaged-macOS distribution and
retains candidate provenance plus the applicable signing and notarization
evidence or explicit not-applicable decision.

The receipt also inventories the browser stylesheet graph from `index.html`
through recursive local CSS imports, the complete checked-in GitHub Pages
payload under `demo/`, and the PNG evidence recursively declared by
`docs/screenshots/manifest.json`. The Pages workflow and this release inventory
must name the same deployment roots.

## Publication checklist

1. Confirm the exact file set for the first public commit or tag.
2. Enable private security reporting on the target GitHub repository.
3. Re-read [SECURITY.md](../SECURITY.md) and residual risk tables.
4. Confirm screenshots under `docs/screenshots/` match `manifest.json`.
5. Tag and publish only under explicit release authority.

## After publication

- Record the tag and commit in `CHANGELOG.md`.
- Record release-specific limitations in the matching file under
  `docs/releases/`.
