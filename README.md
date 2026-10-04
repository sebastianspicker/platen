# Platen

Platen is a local-first PDF workbench with a browser UI, a CLI, and a
token-authenticated loopback host. It keeps source documents immutable and
produces separately validated derived artifacts. Processing uses fixed local
adapters and optional native helpers; it does not upload documents or download
engines at runtime.

`0.3.0-alpha.1` is a public-alpha candidate, not a published release. Interfaces,
output contracts, and capability classifications can change. Use independent
review before relying on any output in unattended or production work.

## Scope and limits

The workbench supports bounded local inspection, page operations, OCR,
conversion, comparison, review, and source-bound mutation profiles. Exact
availability depends on the capability record and installed local engines.
The catalog separates proven behavior from constrained, planned, and unavailable
work. It is not a claim of commercial-suite parity.

Signed local extension metadata install, selection, and rollback remain
available only behind the explicit local admin policy. Each package is canonical
signed JSON metadata only: it cannot contain code, a runtime, payload files,
permissions, or dependencies. Browser-native PDF preview varies by
browser. Accessibility and prepress results are review evidence, not standards
certification. Signature inspection does not establish identity, revocation,
long-term validation, or trust on another system. See
[capability coverage](docs/capability-coverage.md) and
[SECURITY.md](SECURITY.md) for the declared boundaries.

## Requirements

Required:

- Node.js 20 or newer
- Poppler command-line tools: `pdfinfo`, `pdftotext`, `pdftocairo`, `pdffonts`,
  `pdfimages`, `pdfdetach`, `pdfsig`, `pdfseparate`, and `pdfunite`

Optional engines enable additional operations and report explicit unavailability
when absent:

- Tesseract for OCR
- ImageMagick for raster conversion
- Ghostscript for PostScript/EPS, rewrites, and prepress review
- LibreOffice for Office/OpenDocument conversion
- qpdf for validated fast-web-view linearization
- Swift and Xcode on macOS for the PDFKit helper

The project declares no npm runtime or development dependencies.

## Run locally

```sh
npm run dev
```

Open the printed URL. The host binds to `127.0.0.1` and uses a per-process
session token. To choose a port:

```sh
PLATEN_PORT=4180 npm run dev
```

Use the CLI through the same application graph:

```sh
npm run cli -- --help
npm run cli -- engines
```

CLI output publication does not overwrite an existing path.

On macOS, build the optional PDFKit helper with:

```sh
npm run native:build:pdfkit
```

Restart the host after building it. PDFKit-only operations report unavailable
when the helper is absent; other local adapters remain independent.

## Repository layout

```text
.
├── catalog/       Machine-readable capability and research records
├── schemas/       JSON Schemas for checked-in catalog data
├── docs/          Architecture, decisions, capability, frontend, release, research
├── native/        Optional Swift helper packages
├── src/browser/   Browser API clients, bootstrap, controllers, UI, and styles
├── src/cli/       CLI parser, commands, facade use, and output publication
├── src/contracts/ Neutral runtime contracts and validation
├── src/host/      Layered local host: root, bootstrap, transport, application, platform
├── tools/         Verification, reporting, quality, and release utilities
├── index.html
└── package.json
```

## Development and verification

```sh
npm run verify           # repository verification
npm run check:professional-clones
npm run report           # summarize the capability catalogs
npm run release:validate # produce a local inventory receipt
```

A passing `release:validate` receipt is local evidence, not authorization to
tag, publish, sign, notarize, or distribute a release.

## Documentation

| Document | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Physical host layers and dependency directions |
| [ADR 0001](docs/decisions/0001-modular-monolith-contracts-bootstrap.md) | Modular-monolith and composition rationale |
| [ADR 0002](docs/decisions/0002-bounded-runtime-registries.md) | Closed allowlisted dispatch registries |
| [Capability coverage](docs/capability-coverage.md) | Evidence and limits for capability records |
| [Frontend](docs/FRONTEND.md) | Browser UI structure, accessibility, and manual QA |
| [Operations](docs/operations.md) | Source, artifact, engine, and publication behavior |
| [Maintenance checks](docs/maintenance-checks.md) | Routine local verification |
| [Releasing](docs/RELEASING.md) | Candidate and publication procedure |
| [Research sources](docs/research-sources.md) | Capability catalog provenance |
| [Contributing](CONTRIBUTING.md) | Contribution rules |
| [Security](SECURITY.md) | Trust boundaries and private reporting |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Do not include private PDFs, extracted
text, credentials, certificates, or private keys in public issues. Follow the
private reporting process in [SECURITY.md](SECURITY.md) for vulnerabilities.

## License

[MIT License](LICENSE).
