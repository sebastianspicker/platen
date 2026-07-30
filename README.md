# Platen

The local-first PDF workbench.

[Open the static demo](https://sebastianspicker.github.io/platen/). It uses
sanitized fixture data and marks every command-capable action as simulated.

Platen is a local-first PDF inspection and editing tool with a browser
GUI, a CLI, and a token-authenticated loopback host. Sources stay immutable.
Operations write separately validated outputs. Engines are fixed local adapters
(Poppler, optional Tesseract, ImageMagick, Ghostscript, LibreOffice, and an
optional macOS PDFKit helper).

Version `0.3.0-alpha.1` is a public-alpha candidate. Interfaces, output
contracts, capability classifications, and file formats may change. The project
is not suitable for unattended or production processing without independent
review.

## Current scope

- Open, view, search, thumbnail, navigate, inspect properties/resources, and
  download the original file.
- Page composition: split, merge, extract, reorder, crop, rotate, insert,
  replace, duplicate, reverse/interleave, and related page-tree operations.
- Bounded OCR, raster conversion, snapshots, text export, comparison,
  accessibility review, and prepress review subsets.
- Source-bound metadata, annotation, form, navigation, redaction, encryption,
  and PDFKit mutation profiles with operation-specific validation.
- A strict CLI with no-clobber output publication.
- A machine-readable capability catalog under `catalog/` with schema-checked
  claims and test references.

The catalog currently records 318 implemented, test-backed professional claims out of 318 normalized records.
Prototype coverage separately records 0 narrower executable subsets alongside 0 sidecars, 0 proposals, 0 host-only services, 0 descriptors, 0 blockers, and the 0 excluded AI functions.
Prototype coverage is a separate ledger and does not weaken professional claims.
See [capability coverage](docs/capability-coverage.md) and the
generated [feature-gap report](docs/feature-gap-report.md).

## Alpha limitations

- This is not a full commercial PDF suite. Many operations admit only narrow,
  test-backed PDF subsets.
- Third-party plugin installation and execution are disabled. Skeletons under
  `plugins/skeletons/` are non-executable planning contracts.
- Catalog `ai.*` entries are excluded from implementation.
- Browser PDF preview behavior varies by browser. Safe raster views omit PDF
  links, forms, tags, selectable text, layers, and object structure.
- Accessibility review is heuristic and does not establish PDF/UA or WCAG
  conformance.
- Prepress output is review evidence, not press certification.
- Signature inspection does not establish legal identity, revocation, LTV, or
  trust on another system.
- Some macOS PDFKit operations rewrite documents and can change unsupported
  structures or invalidate signatures.
- CLI publication uses exclusive temporary files and hard links; use an
  access-controlled output directory.

Trust boundaries and residual risk are documented in [SECURITY.md](SECURITY.md).

## Requirements

Required:

- Node.js 20 or newer
- Poppler CLI tools: `pdfinfo`, `pdftotext`, `pdftocairo`, `pdffonts`,
  `pdfimages`, `pdfdetach`, `pdfsig`, `pdfseparate`, `pdfunite`

Optional (enable extra operations; missing tools surface explicit unavailability):

- Tesseract (OCR)
- ImageMagick (raster conversion)
- Ghostscript (PostScript/EPS, rewrites, prepress review)
- LibreOffice (Office/OpenDocument conversion)
- Swift and Xcode on macOS (PDFKit helper)

There are no npm runtime or development dependencies.

## Install and run

```sh
# From the repository root
npm run dev
```

Open the printed loopback URL (default port 4173). The host binds to
`127.0.0.1` only and uses a session token.

```sh
# Alternate port
PLATEN_PORT=4180 npm run dev
```

### CLI

```sh
npm run cli -- --help
npm run cli -- engines
```

Outputs are published without overwriting existing paths. Choose a new target
if a path already exists.

### Optional PDFKit helper (macOS)

```sh
npm run native:build:pdfkit
```

Restart the host after building. Without the helper, PDFKit-only operations
report unavailable and leave other engines unaffected.

## Repository layout

```text
.
├── catalog/           Machine-readable capabilities and research scope
├── contracts/         JSON schemas for catalog and operation records
├── docs/              Architecture, coverage, frontend, release, screenshots
├── native/            Optional Swift packages (PDFKit helper, plugin worker)
├── plugins/skeletons/ Non-executable advanced-capability planning manifests
├── scripts/           Host, CLI, verification, and release tools
├── src/               Browser application (controllers, UI, host client)
├── styles/            CSS by surface
├── tests/             Node test suite (*.test.js) and fixtures
├── archive/           Historical materials not required to build or run
├── index.html
├── package.json
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── RELEASE_STATUS.md
└── LICENSE
```

## Development and verification

```sh
npm test                 # full Node test suite
npm run verify           # tests, reachability, catalogs, zero dependencies
npm run check:professional-clones
npm run report           # print feature-gap report
npm run report:write     # write docs/feature-gap-report.md
npm run release:validate # local inventory receipt (not distribution approval)
```

There are no separate lint, format, or type-check scripts. Layout, module size,
schema, and view contracts are enforced by the test and verification suites.

## Troubleshooting

### Engine unavailable

```sh
npm run cli -- engines
```

Install missing system tools through the platform package manager. The
application does not download engines.

### Port already in use

```sh
PLATEN_PORT=4180 npm run dev
```

### CLI output path exists

Choose a new path. Overwrite is intentionally unsupported.

### Operation rejected

Many writers admit only a narrow PDF subset. Read the typed error and the
operation limits in [capability coverage](docs/capability-coverage.md) and
[SECURITY.md](SECURITY.md). Do not weaken admission or postflight checks to
force unsupported input.

### PDFKit functions unavailable

On macOS: `npm run native:build:pdfkit`, restart the host, recheck engines.

## Documentation map

| Document | Purpose |
|----------|---------|
| [docs/architecture.md](docs/architecture.md) | System components and trust boundaries |
| [docs/capability-coverage.md](docs/capability-coverage.md) | What “implemented” means per area |
| [docs/feature-gap-report.md](docs/feature-gap-report.md) | Generated inventory of every capability ID |
| [docs/FRONTEND.md](docs/FRONTEND.md) | UI structure, accessibility, and QA notes |
| [docs/RELEASING.md](docs/RELEASING.md) | Local release process |
| [docs/research-sources.md](docs/research-sources.md) | Catalog research provenance |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution rules |
| [SECURITY.md](SECURITY.md) | Threat model and private reporting |
| [RELEASE_STATUS.md](RELEASE_STATUS.md) | Candidate blockers and local evidence |
| [docs/releases/0.3.0-alpha.1.md](docs/releases/0.3.0-alpha.1.md) | Candidate release note |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Capability status changes require
runtime behavior, bounded failures, fixtures, and validation evidence.

## Security

Use private reporting described in [SECURITY.md](SECURITY.md). Do not attach
private PDFs, extracted text, credentials, certificates, or private keys to
public issues.

## License

[MIT License](LICENSE).
