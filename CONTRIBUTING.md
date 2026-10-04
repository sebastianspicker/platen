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
npm run verify
npm run release:validate
npm run report
```

`npm run verify` is the project-level gate: production-module
reachability, required-file inventory, strict catalogs, and zero npm
dependencies. On macOS, build the PDFKit helper first when
exercising PDFKit paths; startup still tolerates an absent helper.

`npm run release:validate` is for a trusted, quiescent checkout. It emits a
local inventory receipt with a deterministic source-inventory SBOM. Signing,
notarization, retained candidate attestation, and distribution trust remain
unchecked, so `distributionStatus` stays `not-ready`.

`npm run report` summarizes delivery, proof, and prototype status from the
machine-readable catalogs.

Review [docs/RELEASING.md](docs/RELEASING.md) before treating any tree as a
release candidate.

## Capability and catalog rules

- Do not mark a capability `implemented` without runtime behavior and a
  failing-closed error path for rejected input.
- Keep prototype coverage separate from professional delivery claims.
- Update `catalog/` and JSON Schemas under `schemas/` together with host or CLI
  code.

## Code layout

- Browser endpoint clients live under `src/browser/api/`; UI state and rendering
  stay in the other browser areas.
- Neutral runtime contracts live under `src/contracts/`.
- The host is layered: root entrypoints, `bootstrap/`, `transport/http/`,
  `application/`, and `platform/`. Compose concrete collaborators in bootstrap;
  put feature behavior in application and runtime, storage, executable, and
  native-helper work in platform.
- Application areas may depend on each other and platform. Platform must not
  import application. Browser and CLI remain separate adapters.
- CLI parsing and command dispatch live under `src/cli/`; concrete storage and
  provenance access must go through `application.cli`.
- Optional Swift packages live under `native/`.
- Source-symbol analysis enforces a generous per-function cohesion bound.
  Prefer focused behaviors over growing monolithic functions.

## Pull request expectations

- Include tests that exercise the shipped entry points (host functions, CLI
  commands, or UI contracts), not reimplemented copies of the logic.
- Document new limits, admission rules, and failure codes in the relevant docs.
- Do not add npm dependencies without an explicit project decision.
- Do not enable third-party plugin execution.

## Security

Follow [SECURITY.md](SECURITY.md). Never commit secrets, private keys, or
production PDFs with confidential content.
