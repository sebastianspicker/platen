# Public alpha audit

Audit date: 2026-07-22

This document records the repository state observed before public-alpha cleanup.
It is a working release-preparation artifact, not a security certification or a
distribution approval.

## Repository structure

- `src/` contains the dependency-free browser application, controllers, UI
  rendering, and local-host client.
- `scripts/serve.mjs` starts the token-authenticated loopback application host.
- `scripts/platen-cli.mjs` is the command-line entry point.
- `scripts/host/` contains local stores, service boundaries, engine adapters,
  PDF operations, and output validation.
- `native/pdfkit-helper/` contains the optional macOS PDFKit Swift package.
- `native/plugin-worker/` contains an experimental Swift worker package. Public
  plugin execution remains disabled.
- `catalog/`, `contracts/`, and `plugins/skeletons/` define capability claims,
  schemas, and non-executable planning manifests.
- `tests/` contains 403 discovered Node test files.
- `docs/` contains architecture, capability, research, implementation, frontend,
  and screenshot evidence.

The directory is not a Git worktree. There is no tracked-file baseline,
repository history, branch, or remote against which publication scope can be
verified.

## Current application status

Platen is a local-first browser GUI and CLI backed by a loopback Node
host. It keeps selected documents in private local storage and invokes fixed
local adapters for supported operations. The capability catalog contains 318
records: 43 marked as professionally implemented and 275 marked as planned.
Prototype coverage is tracked separately and includes exact alpha behaviors,
narrow executable subsets, sidecar-only behavior, local-service-only behavior,
blocked work, and policy exclusions.

The project is alpha software. Plugin installation and execution are not
available. Many catalog entries are planning or constrained prototypes rather
than general-purpose PDF operations. Local release validation does not establish
signing, notarization, SBOM publication, packaging, or distribution trust.

## Baseline validation

| Command | Result | Observed evidence |
| --- | --- | --- |
| `npm test` | passed | 1,904 passed, 0 failed, 2 skipped, 1,906 total |
| `npm run verify` | passed | Test result above, 403 test files, 806 reachable production modules, 84 native Swift sources, strict JSON catalogs, zero npm dependencies |
| `npm run report` | passed | 318 catalog records, 43 implemented, 275 planned |
| `npm run release:validate` | passed locally | Local receipt only; distribution status remains `not-ready` |

No separate lint, format, or type-check script is configured. Native SwiftPM
builds and tests, browser interaction checks, Markdown link checks, secret
scanning, and isolated installation checks had not yet been run at this point.
The later isolated check found a cold-checkout race because parallel test files
started overlapping SwiftPM builds. The test runners now prepare the native
debug and release products sequentially before starting the Node suite.

A clean copy under a different absolute path still exposes path-dependent
macOS sandbox-probe evidence and timer cancellations that do not reproduce in
the working directory. This remains an environment-sensitive verification
limitation rather than clean-checkout proof.

## Documentation discrepancies

- `README.md` is 854 lines and places a highly detailed operation inventory
  before installation and usage. It is accurate in many details but difficult
  to use as an external entry point.
- `docs/capability-coverage.md` reports prototype tier counts that no longer
  match `npm run report`.
- `docs/FRONTEND.md` records an older 1,901-test result while the current suite
  discovers 1,906 tests.
- `SECURITY.md` refers to a private maintainer reporting channel without naming
  an address or supported private-reporting mechanism.
- `package.json` uses version `0.2.0`, which does not identify a prerelease even
  though the documentation describes the project as alpha software.
- There is no changelog, release note, release checklist, or maintained release
  status document.

## Obsolete, generated, and local-only files

- Ten `.DS_Store` files are operating-system metadata and have no source or
  documentation role.
- `native/pdfkit-helper/.build/` contains about 380 MiB of generated SwiftPM
  output.
- `native/plugin-worker/.build/` contains about 197 MiB of generated SwiftPM
  output and is not covered by the root `.gitignore`.
- `.serena/cache/`, `.serena/project.local.yml`, and `.serena/memories/` are
  local tool state. `.serena/project.yml` is tool configuration, not an
  application requirement.
- No backup, log, local database, coverage, `node_modules`, or `dist` residue was
  found outside ignored or generated locations.
- No ledger, historical task plan, agent output, remediation report, archive,
  or one-off debug file was found outside current implementation and contract
  names.

## Potentially unused or intentionally disconnected files

The production reachability analyzer reports no unexpected unreachable source.
It explicitly classifies 28 modules as intentionally unshipped. The seven
plugin skeletons are referenced by catalog tests and contribution guidance and
must remain non-executable. No source file is proposed for deletion based only
on its name.

## `.gitignore` gaps

- Add `native/plugin-worker/.build/` through a safe SwiftPM build-output rule.
- Exclude local Serena state without hiding application source.
- Add common local environment, coverage, editor, test cache, temporary,
  recording, and local database patterns narrowly enough to avoid source files.
- Confirm that release screenshots under `docs/screenshots/` remain explicitly
  publishable while ad hoc captures are ignored elsewhere.

## Public-release risks

- Required: establish Git history and review the exact files selected for the
  first public commit. The current non-Git directory cannot prove provenance or
  publication scope.
- Required: choose and consistently apply a prerelease version identifier.
- Required: provide an actionable private vulnerability reporting method or
  enable GitHub private vulnerability reporting before publication.
- Required: remove generated and local-only material from the publishable tree.
- Required: validate the visible application and checked-in screenshots against
  the current UI.
- Required: keep plugin execution, broad sanitization, signature identity,
  standards conformance, and distribution trust claims explicitly unavailable
  or limited.
- Required: close the CLI temporary-path substitution window by verifying that
  the published path still identifies the descriptor-bound temporary file, or
  restrict the alpha CLI contract to access-controlled output directories.
- Recommended: add concise release status, release notes, contribution links,
  issue templates, and a pull request template.
- Recommended: document optional engine requirements and platform-specific
  behavior without implying that every engine is installed on every system.

## Secrets, privacy, licensing, and attribution

- No dependency packages are declared and the repository includes an MIT
  license.
- The application documentation states that user PDFs, extracted text,
  credentials, certificates, and keys must not be included in public reports.
- A dedicated secret and private-identifier scan remains required after cleanup.
- Engine names and research-source links require factual attribution, but no
  third-party binary or package dependency was identified in the source tree.
- Screenshot provenance uses a deterministic generated PDF fixture and prohibits
  user documents, tokens, host paths, and credentials.

## Screenshots

Eight curated PNG files are present with matching entries in
`docs/screenshots/manifest.json`. They declare desktop and 390-pixel mobile
captures from Chromium 150 on 2026-07-22. Their paths resolve and dimensions
match the manifest. Visual and interaction validation remains required before
accepting them as current release evidence.

## Proposed cleanup

1. Remove operating-system metadata, native build products, and local Serena
   state after preserving this audit outside the generated directories.
2. Expand `.gitignore` for the technologies and local workflows actually used.
3. Replace the README with a shorter technical entry point linked to detailed
   maintained references.
4. Align version metadata, release validation policy, capability counts, and
   frontend validation evidence.
5. Add release status, alpha release notes, a release checklist, and concise
   GitHub community files.
6. Validate the current UI and screenshots, then rerun source, native, release,
   link, image, secret, and clean-copy checks.

## Files requiring manual confirmation before deletion

- `.serena/project.yml`: retain only if project contributors are expected to use
  the Serena tool configuration. It is not referenced by application, test,
  release, or documentation entry points.
- `PRODUCT.md`: it contains design language and anti-reference notes rather than
  runtime documentation. It may be useful design history, so it is retained.
- `docs/FRONTEND.md`: it combines historical redesign notes with current QA
  guidance. It is retained pending consolidation because screenshots and README
  currently reference it.
- `docs/implementation-plan.md`: it is long and includes future work, but it is
  explicitly linked from capability documentation and distinguishes delivered
  from planned scope. It is retained.
