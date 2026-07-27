# Contributing

Platen separates verified host and engine behavior from research-only
catalog entries. Keep that boundary explicit in code, catalog data, tests, and
documentation.

## Local workflow

Use Node.js 20 or newer. There are no npm dependencies. Poppler is required for
core inspection and page composition. Tesseract, Ghostscript, ImageMagick, and
LibreOffice enable optional OCR, conversion, rewrite, and raster paths. Engine
integration tests skip only when their fixed executable paths are absent.

```sh
npm run dev
npm run native:build:pdfkit
npm test
npm run verify
npm run release:validate
npm run report
```

`npm test` runs every `tests/**/*.test.js` file discovered under `tests/`.
`npm run verify` is the project-level gate: tests, production-module
reachability, required-file inventory, strict catalogs, and zero npm
dependencies. On macOS, build the PDFKit helper before the full suite when
exercising PDFKit paths; startup still tolerates an absent helper.

`npm run release:validate` is for a trusted, quiescent checkout. It emits a
local inventory receipt. Signing, notarization, and SBOM remain unchecked, so
`distributionStatus` stays `not-ready`.

`npm run report` prints the feature-gap inventory.
`npm run report:write` updates `docs/feature-gap-report.md` after intentional
catalog changes.

Review [RELEASE_STATUS.md](RELEASE_STATUS.md) and [docs/RELEASING.md](docs/RELEASING.md)
before treating any tree as a release candidate.

## Capability and catalog rules

- Do not mark a capability `implemented` without runtime behavior, deterministic
  fixtures, and a failing-closed error path for rejected input.
- Keep prototype coverage separate from professional delivery claims.
- Update `catalog/` and schemas under `contracts/` together with host or CLI
  code.
- Run `npm run report:write` only when the generated report must change with the
  catalog.

## Code layout

- Browser UI and client code live under `src/`.
- Host, CLI, engines, and PDF writers live under `scripts/`.
- Optional Swift packages live under `native/`.
- Tests are Node `*.test.js` files under `tests/`, with shared helpers in
  `tests/support/` and fixtures in `tests/fixtures/` where present.
- Source layout and module-size limits are enforced by tests. Prefer splitting
  modules over growing monoliths.

## Pull request expectations

- Include tests that exercise the shipped entry points (host functions, CLI
  commands, or UI contracts), not reimplemented copies of the logic.
- Document new limits, admission rules, and failure codes in the relevant docs.
- Do not add npm dependencies without an explicit project decision.
- Do not enable third-party plugin execution.

## Security

Follow [SECURITY.md](SECURITY.md). Never commit secrets, private keys, or
production PDFs with confidential content.
