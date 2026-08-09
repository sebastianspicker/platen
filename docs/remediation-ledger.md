# Agent-facing capability remediation ledger

## Authority and scope

This ledger is the execution plan for every capability that is not proven in
`catalog/capability-proofs/proofs.json`. It reflects the current catalog of 318
capabilities:

- 210 proven capabilities are outside this ledger.
- 19 partial capabilities require a bounded production boundary or stronger proof.
- 89 false capabilities require a real implementation, a narrower truthful claim, or an explicit permanent exclusion.
- 108 remediation targets are assigned exactly once below.

The capability catalog and proof manifest remain authoritative. This document
organizes work; it does not promote a claim and is not implementation evidence.

## Agent start here

Work the first `READY` item in the recommended order unless the orchestrator
assigns a later independent lane. Do not select work only because a module
already contains a convenient stub.

Before editing:

1. Read the target R-program section and its complete partial and false lists.
2. Reconcile those IDs with the proof manifest; status drift makes the packet
   `HOLD` until the orchestrator regenerates this ledger.
3. Produce the discovery contract defined below, including exact file ownership.
4. Wait for the orchestrator to accept ownership and any shared-file requests.
5. Implement only the accepted claim slice. A nearby capability remains out of
   scope unless it has its own audit row.

Every worker handoff must contain these headings:

- `Claim decisions`: one `PROMOTE` or `HOLD` row per capability ID;
- `Production boundary`: entrypoint, authority, retained artifact, and digest;
- `Owned changes`: exact production and test files changed;
- `Evidence run`: commands, passing results, and unrun or external lanes;
- `Ledger delta`: counts and synchronized files requested from the orchestrator;
- `Remaining blockers`: exact failed proof dimensions, without roadmap language.

## Status and promotion rules

Agents must preserve these meanings:

- `partial`: a real bounded subset or service exists, but at least one proof dimension is incomplete.
- `false`: the broad claim is absent, synthetic, source-dropping, policy-excluded, or unsupported.
- `proven`: permitted only after the catalog wording, shipped surface, production authority, failure behavior, trust boundary, and independent validation all describe the same bounded behavior.

A remediation may end in one of three outcomes:

1. Implement and prove the claim as written.
2. Narrow the catalog wording to the exact useful behavior, then prove that behavior.
3. Retain `false` with an explicit product, policy, platform, or dependency blocker.

No agent may promote a claim from a descriptor, fixture-only handler, injected
test double, demo fallback, or output that is not reread from its retained
authority. External signing, notarization, network, identity, hardware, and
vendor evidence must remain separate from local proof.

## Standard agent packet

Each claim receives its own audit row and `PROMOTE` or `HOLD` decision. One
implementation packet may cover several claims only when they share one
production authority; its audit matrix must still report every claim
separately.

Before editing production code, the mapper records this discovery contract for
each claim in the packet handoff:

- current catalog wording and proposed narrower wording, if any;
- first failing proof dimension and exact evidence reference;
- authoritative production entrypoint and retained artifact or state owner;
- implementation owner, exact owned files, tests, and shared-file requests;
- prerequisite program or authority and required positive and hostile evidence.

The orchestrator must accept that mapping before assigning an implementation
worker. This discovery record is the claim-specific completion contract; the
program gate below supplements it rather than replacing it.

The packet then follows these steps:

1. Map the catalog wording, proof record, effect contract, production handler,
   composition root, route or command, client or UI, retained store, and tests.
2. Record the first failing proof dimension: source binding, failure evidence,
   trust boundary, or independent validation.
3. Implement through the authoritative service. Reject synthetic wrappers and
   caller-supplied provenance.
4. Add preflight source verification, post-operation source verification,
   retained-byte rereading, output digest checks, cancellation, disconnect
   cleanup, and cleanup-failure aggregation where applicable.
5. Add a shipped entrypoint and strict result validation. UI-only claims also
   require keyboard, focus, error, unavailable, and stale-result behavior.
6. Add positive installed-service evidence when an engine is available and
   negative tests for drift, tampering, forged identities, accessors, proxies,
   cancellation, and cleanup failure.
7. Ask a separate audit agent to evaluate the current wording or the explicitly
   proposed narrower wording and return `PROMOTE` or `HOLD` for each claim.
8. Only after `PROMOTE`, apply any approved wording change and synchronize the
   catalog, proof manifest, prototype
   coverage, effect contract, generated report, documentation counts, and tests.
9. Run focused tests, proof verification, source-layout gates, `npm run verify`,
   `npm run release:validate`, and `git diff --check`.

Ownership is one read-only mapper or auditor plus one implementation worker per
packet. The assignment matrix below reserves module families by program. Before
parallel work starts, the orchestrator replaces each family with an exact,
disjoint file list from the discovery contract. Shared routers, composition
roots, catalogs, generated reports, inventories, and broad integration tests
remain orchestrator-owned.

## Program summary

| Program | Priority | Partial | False | Total | Primary remediation shape |
| --- | --- | ---: | ---: | ---: | --- |
| R01 Shell and plugin platform | P1 | 0 | 3 | 3 | Permission, RPC, and runtime sandbox boundary |
| R02 Creation, conversion, and export | P0 | 1 | 1 | 2 | Remaining engine and heterogeneous-input fidelity proof |
| R03 Content and page authoring | P0 | 0 | 2 | 2 | Bounded PDF mutation services and semantic reinspection |
| R04 Review, annotations, and forms | P0 | 0 | 5 | 5 | Source-bound workflows, collaboration authority, AcroForm mutation |
| R05 Signing and security trust | P1 | 0 | 16 | 16 | Native identity, certificate, encryption, and consent authorities |
| R06 Capture, OCR, redaction, and sanitization | P0 | 2 | 1 | 3 | Hardware acquisition and persistent OCR training authority |
| R07 Comparison and accessibility | P0 | 2 | 1 | 3 | Two-source evidence and inventory-to-repair closure |
| R08 Standards, preflight, color, and print | P1 | 0 | 17 | 17 | Installed conformance and prepress engines, post-promotion revocation |
| R09 Collaboration, automation, integrations, and administration | P1 | 10 | 20 | 30 | Durable ownership plus explicit external adapters |
| R10 AEC workflows | P0 | 0 | 0 | 0 | Closed with bounded local geometry, records, and revision workflows |
| R11 Portfolios, rich media, 3D, and geospatial | P2 | 4 | 8 | 12 | Specialized containers and native media or geometry engines |
| R12 AI policy exclusions | P3 | 0 | 15 | 15 | Retain exclusion unless local deterministic policy changes |
| **Total** |  | **19** | **89** | **108** | Exact closure over every non-proven claim |

## Agent assignment matrix

These are exclusive starting boundaries, not permission to edit every matching
file. Each worker owns only the exact subset accepted in its discovery contract.
Matching focused tests travel with that owner. Broad delivery, catalog, router,
CLI-parser, required-file inventory, and report files stay with the orchestrator.

| Program worker | Reserved production families | Prerequisite or hold condition |
| --- | --- | --- |
| R01 | `src/controllers/viewer/`, plugin platform and native plugin modules | Signed-package and sandbox design before false claims |
| R02 | create-convert modules, conversion services, `src/controllers/document-generation/` | Installed conversion engine and retained-artifact contract |
| R03 | content-editing, page-organization, and `src/controllers/page-composition/` | PDF mutation authority; establishes shared mutation rules |
| R04 | annotation, forms, and `src/controllers/review/` modules | R03 mutation rules for page-content effects |
| R05 | signature, security, protection, and native signing-identity modules | Native identity or cryptographic authority |
| R06 | scan, OCR, redaction, sanitization, and `src/controllers/ocr-workflow/` | OCR or device adapter; R03 rules for destructive PDF changes |
| R07 | comparison and accessibility modules and writers | Two-source digest contract; R03 rules for PDF repairs |
| R08 | standards-preflight, color, printer-mark, and prepress modules | Installed conformance or print engine |
| R09 | collaboration-DMS, automation-headless, integrations, and admin modules | Durable state owner locally; vendor adapter externally |
| R10 | AEC, CAD geometry, and `src/controllers/aec-workflow/` | R03 mutation rules and retained measurement records |
| R11 | portfolio, rich-media, specialist-embed, 3D, and geospatial modules | Explicit native container or media dependency |
| R12 | No implementation owner under current policy | Product and privacy policy decision |

## R01 Shell and plugin platform

Priority P1. First close bounded viewer behavior with deterministic browser
tests. Treat plugin installation and runtime as one security program: signed
packages, dependency closure, permission grants, process isolation, lifecycle
rollback, and registry trust must share one authority.

Partial (0): None.

Verified closure (2026-08-04): platform.plugins.capability-conflicts is proven
through the authenticated same-origin OS-local active-plugin capability route.
One bounded package-store snapshot is revalidated against signed,
integrity-checked launch descriptors; inactive and manifest-v2 metadata-only
packages are excluded, malformed or identity-drifted records fail closed, and
manifest-v3 executable declarations produce sorted conflict records with the
lexicographically first provider as a read-only recommendation. The browser
client independently reconstructs the conflict set, rejects omitted, extra,
duplicate, unsorted, shortened, or forged selections, and deep-freezes the
accepted response. Cancellation aborts the snapshot without mutation. Provider
ordering uses fixed `en` collation; other locale behavior and localized
presentation are not claimed. A snapshot may become stale after concurrent
activation changes.
Plugin execution, activation mutation, runtime dispatch enforcement, remote
registries, dependency resolution, permission enforcement, and runtime conflict
resolution remain explicitly outside the claim.

Verified closure (2026-08-02): four browser viewer claims are proven through
the live UI rather than the older generic host descriptors. viewer.page-layouts
cycles selected-page, continuous, facing, and cover-facing layouts over the
immutable local PDF URL; continuous mode is capped at the first 32 pages.
viewer.split-view places one selected immutable PDF page beside escaped,
source-bound extracted text. viewer.reflow renders the ready source-bound text
pages as escaped read-only sections. viewer.rulers-grid is narrowed to one
source-bound CSS grid overlay and does not claim rulers, guides, snapping,
measurement, or PDF mutation. All four require a local `blob:` URL plus ready
analysis with a canonical document UUID, SHA-256, page count, and validated text
records. Loading, error, malformed, forged, stale, closed, and non-local states
fall back without rendering untrusted content. Deterministic production-render
tests cover the current boundary; a real-browser or Playwright lane is not
configured and was not run. The repository verification gate passed 2,406
tests with 2,404 passes, 2 intentional skips, and no failures; it also verified
918 reachable production modules and all 318 capability-proof records. Local
release validation and `git diff --check` passed. Signing and notarization were
not checked because external release evidence was not provided.

Verified closure (2026-08-04): five package-state claims use the authenticated
local plugin-package route and durable package store. Installation admits
canonical signed package bytes through plugin-scoped Ed25519 publisher trust,
then rereads digest-addressed installed content. Dependency resolution accepts
only exact local ID, version, and digest pins and rejects missing or cyclic
graphs. Activation and explicit rollback terminate registered runtime authority
before durable state changes. The reopened registry exposes installed, active,
and previous versions without package paths, manifests, or source. Cancellation,
same-version digest conflicts, tampering, arbitrary downgrade, and corrupt
registry state fail closed. Remote marketplaces, dependency fetching, hot
reload, distributed lifecycle control, and automatic recovery are excluded.

False (3): `platform.plugins.rpc`, `platform.plugins.permissions`,
`platform.plugins.runtime-sandbox`.

Promotion gate: the remaining executable-plugin claims require enforced
permissions, authenticated RPC, a real isolated worker, and adversarial escape
tests. Signed package admission, pinned dependencies, durable registry state,
activation, and rollback are already proven.

## R02 Creation, conversion, and export

Priority P0. Split by engine family so office, image, PostScript, CAD, OOXML,
structured text, image extraction, compression, and web optimization do not
share synthetic conversion evidence.

Partial (1): `optimize.fast-web-view`.

False (1): `create.multiformat-combine`.

Promotion gate: a shipped route or command must invoke the installed engine,
retain the exact artifact, reread it, and prove relevant page count, text,
geometry, media type, source digest, and cancellation behavior. Format fidelity
claims must state what is not preserved.

Verified closure (2026-08-08): create.print-to-pdf is proven only as the macOS
`print-to-pdf-local INPUT.txt --output OUTPUT.pdf` command for one 1-byte
through 8-MiB strict UTF-8 NUL-free text/plain `.txt` source. It invokes the
fixed `/usr/sbin/cupsfilter` executable only when the complete filter plan is
exactly `cgtexttopdf`, retains source and derived bytes privately with
SHA-256-bound provenance, and has installed Poppler inspect the exact retained
PDF before export for 1 through 64 sequential pages, bounded geometry and
text, and passive indicators. Export stages and reinspects the retained PDF,
then publishes one new 0600 single-link file whose exact inode, bytes, and
SHA-256 are reread before receipt completion. Physical printing, printer
selection, PPDs, print options and dialogs, fallback engines, other input
formats, and visual, font, layout, pagination, or print fidelity are excluded.

Verified closure (2026-08-04): convert.images-to-pdf is proven only as one
bounded non-interlaced 8-bit RGB or RGBA PNG converted by installed ImageMagick
to one separately retained one-page PDF. Source and normalized PNG digests are
bound through the private input store and operation provenance; Poppler rereads
the exact retained PDF bytes for one bounded page, geometry, empty text, one RGB
image with at most one soft mask, and passive encrypted=no, JavaScript=no, and
Form=none indicators. The CLI publishes one new 0600 single-link output and
rereads the exact inode and SHA-256 before source-bound receipt emission.
JPEG, TIFF, multiple images or pages, PNG metadata, profiles, animation,
non-RGB preservation, exact pixel or color fidelity, general format fidelity,
and broader image-format claims remain excluded. Failures and cancellation
before commit revoke the exact promoted document and output; successful receipt
emission is the commit boundary, so later cancellation is post-commit. The
runtime residual is the installed ImageMagick and Poppler dependency and the
bounded PNG/PDF contract, not a general image conversion guarantee.

Verified closure (2026-08-08): convert.html-to-pdf accepts one bounded UTF-8
`.html` file containing only the exact standard HTML doctype and an explicit
attribute-free passive-element allowlist. CSS, attributes, resources, comments,
declarations, scripts, forms, active elements, NULs, and malformed UTF-8 are
rejected before retention. Installed LibreOffice converts the digest-bound
private input through fixed arguments; deterministic fallback provenance is
rejected. Poppler reinspects the exact retained PDF bytes for bounded sequential
pages, geometry, extracted text, and passive indicators before one new 0600
single-link output is published and reread by inode, size, and SHA-256. Failures
and cancellation before receipt completion revoke the derived document and
output. Browser rendering, links, images, fonts, accessibility or conformance,
and visual, font, layout, or pagination fidelity remain excluded.

Verified closure (2026-08-08): create.cad-to-pdf is proven only as one bounded
strict UTF-8 DXF containing exactly one ENTITIES section and 1 to 2,000 LINE
records. The private input store binds source size and SHA-256, and the strict
parser rejects all other sections, entities, group codes, malformed pairs, and
unsupported coordinates before its validated entity model reaches the built-in
renderer. The separately retained one-page PDF is reread through installed
Poppler for a passive 612 by 792-point page; retained vector-operator checks and
installed pdftocairo evidence confirm visible line output. The CLI publishes one
new 0600 single-link output and rereads the exact inode, bytes, and SHA-256.
Source or artifact drift, forged evidence, publication failure, and cancellation
before commit fail closed and revoke the derived document. Coordinates are
unitless PDF-space values from 0 through 14,400, rounded to six decimals, drawn
as black one-point strokes, and clipped outside the fixed page. General DXF,
CAD, BIM, units, layers, styles, metadata, multipage output, and exact visual
fidelity remain excluded.

Aggregate verification (2026-08-08): `npm run verify` completed with 2,970
tests, 2,968 passes, 2 intentional skips, and no failures across 632 test files
and 1,037 reachable production modules. The proof verifier closed all 318
records at 210 proven, 19 partial, and 89 false. Release validation passed the
local inventory; distribution remains not ready because external signing and
notarization evidence was not provided.

Verified closure (2026-08-04): five additional R02 claims are proven through
dedicated source-bound commands, with their older generic professional handlers
retired at both CLI and host dispatch. create.postscript-to-pdf accepts one
bounded PS or EPS source, uses installed Ghostscript, retains source-digest
provenance, and has Poppler reread the exact derived PDF for 1 to 64 pages,
geometry, extracted text, and passive indicators before verified publication.
export.text-rtf and export.html-xml verify one retained PDF around installed
Poppler extraction and publish deterministic bounded RTF, HTML, or XML for 1 to
200 sequential text-page records; visual, layout, semantic, and editable-object
fidelity remain excluded. export.images renders one selected page at exactly 72
or 150 DPI, then validates the complete PNG structure, CRCs, dimensions, size,
and digest before publication. optimize.compress is narrowed to a fixed
Ghostscript rewrite whose size result is measured rather than guaranteed;
Poppler requires identical source/output page count, geometry, and extracted
text plus passive output indicators. Precommit failures and cancellation revoke
validated derived documents or leave no published output, and successful
verified receipt emission is the commit boundary.

Verified closure (2026-08-04): five further R02 claims use dedicated paths with
the generic professional dispatcher retired. Clipboard creation admits exactly
one consented browser PNG, retains it privately, converts it with installed
ImageMagick, validates the one-page PDF through Poppler, verifies the source
digest, and cleans temporary host state. Word, Excel, and PowerPoint export are
narrowed to bounded text-only DOCX, XLSX, and PPTX packages produced from
source-bound Poppler page text. Their retained ZIP bytes, media type, size,
digest, provenance, route, and exclusive CLI publication are verified; visual,
table, font, layout, semantic, and office-application fidelity are excluded.
Selected-region export verifies one retained PDF and publishes one validated
Poppler PNG for an admitted page, normalized top-left CropBox region, and DPI.
Text, vector, PDF-object extraction, arbitrary DPI, and general render fidelity
are excluded. Drift, cancellation, tampering, forged artifact identities, and
publication failure fail closed.

## R03 Content and page authoring

Priority P0. Build mutations around immutable source locators and independent
PDF inspection. Keep text, image, vector, navigation, attachment, layer, active
content, page-box, resizing, and blank-page operations separate.

Partial (0): None.

False (2): `document.flatten-content`, `pages.resize`.

Current disposition (2026-08-07): document.flatten-content is conditional on a
distinct source-bound flatten authority. Reusing the already-proven one-square
review annotation path would duplicate review.annotation-flatten without adding
document-level forms, layers, transparency, or another independently useful
flatten target. pages.resize remains conditional on a PDF-native resize
authority because the available raster rewrite destroys professional PDF
structure. Neither claim blocks later READY work while those authorities are
absent.

Verified closure (2026-07-31): pages.page-boxes is proven only for one
selected persistent CropBox or BleedBox in a retained source-bound PDF. The
production CLI and composition root bind the exact source digest, constrain
geometry through the PDFKit mutation service, independently reinspect the
target box with Poppler, reread the retained bytes and provenance, render every
page, and require fixed 256-pixel source/output render equality for BleedBox.
Failed postflight and cancellation paths revoke only the artifact captured from
the mutation authority, and CLI receipts exclude PDF bytes, source digests, and
private paths. MediaBox, TrimBox, and ArtBox editing, general syntax
preservation, and broad render, semantic, or print equivalence remain excluded.
The final audit found and resolved five implementation gaps before closure:
privacy-safe receipts still exposed retained artifact paths; cleanup could act
on an untrusted outcome artifact when no authoritative promotion was captured;
signal options accepted accessor, symbol, or non-plain-object descriptors;
retained source and artifact buffers were not consistently zeroed after
verification; and the effect contract still named the obsolete synthetic
page-box marker. Regression coverage now enforces the corrected receipt,
cleanup-authority, descriptor-validation, memory-hygiene, and source-bound
PDFKit effect boundaries.
The final focused gate passed 41 tests; aggregate verification passed 2,261
tests with 2 explicit skips and 0 failures across 903 reachable production
modules. Local release validation passed, while distribution remains not ready
without external signing and notarization evidence.

Verified closure (2026-08-03): seven R03 claims now use exact bounded wording
and production authorities instead of synthetic professional handlers.
document.backgrounds applies one opaque solid RGB fill behind selected supported
pages; document.bates-numbering applies passive identifiers to selected pages of
one PDF; document.bookmarks-author creates, removes, or renames one supported
top-level direct bookmark on macOS; document.destinations-author appends one
bounded direct Fit destination; and document.attachments-manage removes one exact
supported embedded file through a private closed rewrite. Each path binds an
immutable source digest, retains and rereads a separate artifact, independently
reinspects its narrow effect and preservation contract, revokes failed output,
and keeps its broader add, edit, batch, nested, active, or multi-object semantics
excluded. document.watermarks now applies one fixed opaque black 36-point
Helvetica text watermark to selected admitted pages through a new private
source-bound job, retained artifact, independent topology and effect proof,
privacy-safe CLI receipt, cancellation, and cleanup boundary. pages.insert-blank
now generates one standard 612 by 792 point text-empty PDF through the local
blank factory, binds both input digests, inserts it after one selected page, and
rechecks the retained ordered manifest, page count, inserted geometry, empty
text, provenance, and output digest. Arbitrary blank dimensions, multi-page
blank insertion, watermark update or removal, and unsupported document graphs
remain excluded. pages.resize remains blocked because the available raster path
destroys professional PDF structures and no PDF-native resize authority exists.
The integrated repository gate passed 2,445 tests with 2 explicit skips and 0
failures across 925 reachable production modules and all 318 closed capability
proof records. Local release validation passed, while distribution remains not
ready without external signing and notarization evidence.

Verified closure (2026-08-03): five additional R03 claims now point only to
dedicated source-bound production authorities. edit.add-text appends one bounded
printable-ASCII Helvetica text run to a selected content-empty page and verifies
the retained incremental artifact with raw and Poppler evidence. edit.text-reflow
rewraps one paragraph across 2 to 32 existing fixed-width Tj line slots without
changing the content-stream length, page geometry, typography, or page count.
edit.images admits one private baseline grayscale or RGB JPEG for a bounded
insertion or one direct JPEG XObject replacement, with the replacement path also
checking page, text, box, image, and render preservation. edit.vector-objects
appends one fixed black 1-point stroked rectangle within a content-empty page
CropBox and requires only the selected page render to change.
document.layers-manage changes only the default visible state of ordered existing
optional-content groups through a catalog-only incremental revision. General text
boxes, layout reflow, image transformation, arbitrary vector paths, existing
object editing, and layer creation, assignment, renaming, reordering, deletion,
or flattening remain excluded. The source-dropping generic handlers and their
marker-based effect contracts were removed for all five claims.
The integrated focused gate passed 89 tests with no failures. Aggregate
verification passed 2,476 tests with 2,474 passes, 2 intentional skips, and no
failures across 929 reachable production modules and all 318 closed capability
proof records. Local release validation passed, while distribution remains not
ready without external signing and notarization evidence.

Verified closure (2026-08-05): document.actions-javascript is narrowed to
removing exactly one admitted Catalog OpenAction or flat Names JavaScript locus
from a supported classic PDF. The professional handler binds the immutable
source digest to the existing local JavaScript-removal service, returns only a
separately retained artifact receipt, and validates that receipt through the
shared client contract. The composed local application injects that authority
through the source-bound content-editing delivery wrapper, which rereads and
hashes the promoted artifact before delivery completes. The underlying service
closes prior revisions, independently reinspects raw JavaScript surfaces and
removed references,
rechecks page text, boxes, and validation renders, and revokes failed or
cancelled promotion. Script execution, authoring, multiple loci, page or form
actions, and unsupported PDF graphs remain excluded. Focused professional,
service, and writer evidence covers strict delegation, unavailable authority,
invalid requests, forged receipts, hostile sources, cancellation, cleanup, and
installed Poppler reinspection, including the composed application path.

Verified closure (2026-08-05): edit.headers-footers is narrowed to appending
one fixed black monospaced Courier header and an automatic page-number footer to selected
unrotated pages of one admitted passive classic PDF. The composed source-bound
delivery binds the immutable source digest to a private local job, retains a
separate append-only artifact, rereads and hashes its bytes, and independently
reinspects the exact header and footer streams. The writer preserves the source
revision as the byte prefix, page tree, boxes, annotations, original resources,
and unselected pages. Selected original content is tokenized for balanced state
and isolated before the new effect; external stream authority, reserved font
references, extra trailer authority, and unexpected incremental writes fail
closed. Failed validation, cancellation, or cleanup revokes the
promoted artifact; the CLI copies output exclusively, removes its retained
temporary artifact, zeroes request bytes, and emits an allowlisted receipt with
no source digest, text, paths, provenance parameters, or PDF bytes. Forms,
actions, tags, layers, signatures, encryption, templates, images, transparency,
rotated pages, and complex PDF structures remain excluded.

Verified closure (2026-08-05): edit.object-properties is narrowed to changing
only the bounds and RGB border color of one existing inert Square annotation
selected by page, page-local index, subtype, and source-bound fingerprint. The
authenticated editor and client submit the exact request to a private staged
PDFKit job, which retains a separate artifact only after native reopen, raw
three-component `/C` inspection, Poppler validation, retained-byte digest
verification, and descriptor comparison. Contents, flags, the target appearance
descriptor shape, and every non-target annotation descriptor are preserved.
Admission requires every annotation present in the source to already carry an
`/AP` dictionary so PDFKit cannot synthesize unrelated appearances; pages with
no annotations remain eligible. Cancellation, private-workspace cleanup
failure, failed artifact revocation, and disconnected response delivery are
explicit lifecycle outcomes. General objects, fills, opacity, blend modes,
appearance-stream authoring, and other annotation subtypes remain excluded. The
independent promotion audit passed after target `/AP` preservation and retained
artifact lifecycle gaps were repaired; the focused native, service, route, and
authenticated staged-helper gate passed 25 tests with no failures. Aggregate
verification passed 2,890 tests with 2,888 passes, 2 intentional skips, and no
failures across 610 test files, 1,015 reachable production modules, and all 318
closed capability-proof records.

Promotion gate: each mutation needs an exact source-bound request, private job
workspace, separately promoted output, independent semantic reinspection,
retained-byte digest verification, and revocation on every failed postflight.

## R04 Review, annotations, and forms

Priority P0. Use three lanes: local annotation authoring, collaboration or
notification services, and AcroForm authoring or data workflows. Do not infer a
shared-review backend from local sidecar behavior.

Partial (0): None.

False (5): `review.custom-stamps`,
`forms.calculate`, `forms.distribute-collect`,
`forms.submit-reset`, `forms.flatten`.

Promotion gate: annotation mutations must prove exact locator effects and safe
interchange. Forms must prove field inventory, deterministic validation,
keyboard order, saved values, appearance consistency, and explicit rejection
of unsupported XFA, JavaScript, signatures, or ambiguous field graphs.

Verified closure (2026-08-02): review.annotation-flatten is proven only for the
authenticated one-square profile. The UI gate, local client, and route bind one
inspected square annotation to the immutable source digest. A private job
promotes its small passive normal appearance into a separate closed-rewrite
PDF, removes the annotation and prior revisions, rereads the retained bytes,
and verifies raw structure plus Poppler semantic and fixed-size all-page render
invariants. Failed, cancelled, or disconnected deliveries revoke the promoted
artifact. General annotation or form flattening, sanitization, signature
preservation, and other annotation subtypes remain excluded. The same audit
retained annotation interchange, barcode fields, and field detection as
partial: they respectively lack a retained source-bound interchange lifecycle,
a shipped route or CLI authority, and an AcroForm widget inventory.
The focused integration gate passed 34 tests. Aggregate verification passed
2,414 tests with 2,412 passes, 2 intentional skips, and no failures across 486
test files and 918 reachable production modules.

Verified closure (2026-08-03): forms.barcode-fields is narrowed to one
authenticated source-bound Code 39 mutation for a passive form-free PDF. The
local document route validates the exact request and service receipt, delegates
to the retained PdfAcroFormBarcodeService, rereads and independently inspects
the artifact, suppresses private paths, and revokes failed or cancelled work.
Scanner interoperability, other symbologies, active documents, existing forms,
general form authoring, and a CLI or browser client are excluded. The final
claim gate uses the real DocumentStore and production service rather than a
handcrafted receipt. It also proves that a forged foreign artifact identifier
cannot authorize deletion while a store-confirmed failed promotion is revoked.
The focused barcode route, writer, service, and forms gate passed 21 tests.

Verified closure (2026-08-03): four R04 claims now use dedicated authenticated
local workflows instead of the generic professional-capability dispatcher.
review.file-audio-attachments embeds one bounded local text, binary, or
validated PCM WAV asset as an inert FileAttachment on one eligible passive PDF
page; Sound, RichMedia, autoplay, and general attachment authoring remain
excluded. review.measurements adds one calibrated distance, perimeter, or
area measurement, retains the derived PDF, and requires native plus embedded
Measure validation; general CAD measurement tooling remains excluded.
review.comments-to-office exports a source-bound text-only DOCX summary of
review annotations and replies without Word tracked-comments or round-trip
interoperability. forms.javascript-actions exposes only a privacy-safe
inventory of exact inline K, F, V, and C action loci; script text, authoring,
mutation, evaluation, and execution remain excluded. Each route validates the
authenticated request and service result, binds the immutable document or
source digest, suppresses private paths or contents, and limits cleanup to
store-confirmed artifacts. Dedicated claim tests cover success, rejection,
disconnect, forged-result, and revocation boundaries. Aggregate verification
passed 2,487 tests with 2,485 passes, 2 intentional skips, and no failures
across 506 test files, 938 reachable production modules, and all 318 closed
capability-proof records.

Verified closure (2026-08-03): the next R04 packet replaces three more
synthetic dispatcher claims with real local authorities. review.shared-review
now means one bounded canonical Platen review-exchange ZIP whose source digest,
base revision, reviewer, annotation deltas, and comment deltas are validated;
import is atomic and idempotent, and the exchange contains no PDF bytes or
remote sharing transport. review.notifications-mentions now generates and
marks read only local workspace records derived from bounded annotation or
reply mentions under exact source-digest and revision guards; email, push, and
remote delivery remain excluded. forms.static-to-fillable now means creating
one empty passive terminal text field in a separately retained source-bound PDF
from an eligible form-free passive source. Existing forms, other field types,
signatures, JavaScript, calculations, XFA, and byte or signature preservation
remain excluded. Dedicated authenticated route/client tests cover the real
services, exact request shapes, forged results, cancellation, revision
conflicts, retained artifact validation, and client result freezing.
Aggregate verification passed 2,496 tests with 2,494 passes, 2 intentional
skips, and no failures across 509 test files, 942 reachable production modules,
and all 318 closed capability-proof records.

Verified closure (2026-08-03): the next R04 packet promotes three existing
subsets behind exact production boundaries. review.drawing-markup now means
only one fixed native straight-line annotation or one fixed native open ink
path in a separately retained source-bound PDF; general freehand, arrows,
polygons, clouds, shapes, styling controls, active content, signed inputs, and
encrypted inputs remain excluded. forms.detect-fields now means a bounded
macOS PDFKit read-only widget inventory that omits values and private paths and
never executes actions; it does not detect candidate fields from page text or
perform form mutation. review.annotation-import-export now imports one
canonical Text annotation XFDF record into an eligible single-revision classic
PDF, retains a separate source-bound artifact, and returns canonical XFDF. FDF,
multiple or non-Text annotations, indirect annotation arrays, general XFDF,
source mutation, and remote transport remain excluded. The former generic
handlers and effect fixtures for all three claims were removed. Dedicated
claim tests cover authenticated route and client composition, immutable source
binding, native or independent reopen evidence, retained artifact lifecycle,
forged results, source drift, cancellation, optional-service absence, and
unsupported input rejection.
Aggregate verification passed 2,503 tests with 2,501 passes, 2 intentional
skips, and no failures across 512 test files, 946 reachable production modules,
and all 318 closed capability-proof records.

Verified closure (2026-08-03): the next R04 packet promotes four narrowly
bounded local authorities. review.comments now adds one sticky Text annotation
through the source-bound PDFKit mutation route and retains a separate derived
PDF; it does not provide threaded replies or collaborative review state.
review.annotation-properties now changes only the contents and bounds of one
exact existing FreeText, Square, Circle, or Highlight annotation identified by
page, index, subtype, and source-bound fingerprint. Author, color, opacity,
appearance streams, defaults, and other subtypes remain excluded. forms.author
now creates exactly one unchecked checkbox, one unchecked bounded radio group,
or one non-combo bounded choice field in an independently reinspected retained
PDF from an eligible form-free passive source. forms.xfa-compatibility is
replaced by a truthful source-bound XFA key-presence inspection on the Catalog
or a direct AcroForm dictionary. It never dereferences XFA values and claims no
XFA reading, rendering, filling, conversion, validation, preservation, or
compatibility. The generic dispatcher handlers and effect fixtures for all four
claims were removed. Dedicated tests cover authenticated route and client
composition, source and locator binding, retained artifact lifecycle, native
or independent reopen proof, decoy and malformed inputs, source drift,
cancellation and revocation, forged receipts, and active-document rejection.
Aggregate verification passed 2,521 tests with 2,519 passes, 2 intentional
skips, and no failures across 518 test files, 953 reachable production modules,
and all 318 closed capability-proof records.

Verified closure (2026-08-03): the next R04 packet promotes four claims through
one digest- and revision-bound local review sidecar. review.statuses updates the
status of one existing retained annotation and appends one bounded local
activity record. review.filter-sort returns only bounded filtering, grouping,
and sorting over retained local annotations. review.comment-summary returns a
local text-only comment rollup. review.review-tracking returns only retained
local sidecar activity records. These workflows do not mutate or read PDF
annotations, provide remote or multi-user collaboration, manage participants,
assignments, due dates, or outstanding work, or produce PDF, CSV, XML, or print
reports. Strict service, route, and client contracts bind each operation to the
immutable source digest and exact workspace revision, reject forged results,
and expose only frozen local-only receipts. The four generic dispatcher
handlers and synthetic effect fixtures were removed. Focused tests cover status
mutation, retained activity, query results, source drift, revision conflicts,
cancellation, malformed snapshots, forged responses, optional-service absence,
and client result freezing.
Aggregate verification passed 2,532 tests with 2,530 passes, 2 intentional
skips, and no failures across 522 test files, 957 reachable production modules,
and all 318 closed capability-proof records.

Verified closure (2026-08-03): the next R04 packet replaces three broad review
claims with fixed authenticated PDFKit derived-copy profiles. review.markup-tools
now creates one inert Highlight annotation at an explicit page rectangle.
review.text-markup creates one inert Underline annotation at an explicit page
rectangle. review.text-notes-callouts creates one inert FreeText box at an
explicit page rectangle. Each workflow binds the immutable source digest,
retains a separate output, reopens and independently inspects the exact subtype,
contents digest, and bounds, and revokes failed or cancelled work. Standard
annotation creation now also rejects signed or indeterminate-signature sources.
Text selection and QuadPoints targeting, drawing, stamps, sticky notes, callout
leaders, strikeout, squiggly, insert or replace semantics, styling controls,
replies, collaboration, signed, encrypted, form-bearing, or active inputs, and
source mutation remain excluded. The three generic dispatcher handlers and
synthetic effect fixtures were removed. Dedicated tests cover the real
service, authenticated route and client, retained-artifact lifecycle, native
reopen and raw structure, source preservation, unsafe sources, cancellation,
forged receipts, malformed requests, and unsupported subtype rejection.
Aggregate verification passed 2,542 tests with 2,540 passes, 2 intentional
skips, and no failures across 524 test files, 957 reachable production modules,
and all 318 closed capability-proof records.

Verified closure (2026-08-03): forms.fill-save now updates exactly one existing
terminal classic AcroForm field (Tx, Ch, canonical checkbox, or canonical
radio) in a separate source-bound incremental derived PDF, preserves the source
prefix, and independently reopens the exact V/AS. forms.validate now performs
authenticated read-only required/type/min/max validation for submitted values
bound to safely inspected existing terminal fields and returns value-free
errors with hashed field identifiers. Fill/save excludes appearance
regeneration, flattening, calculations, interchange, XFA, signatures, and byte
or signature preservation. Validation excludes regex, JavaScript and actions,
calculations, XFA, signatures, mutation, artifacts, and ambiguous or
unsupported graphs. Aggregate verification passed 2,555 tests with 2,553
passes, 2 intentional skips, and no failures across 528 test files, 965
reachable production modules, and all 318 closed capability-proof records.

Verified closure (2026-08-05): forms.import-export-data is proven only as an
authenticated local read-only export of the nearest inherited name and current
string value of exactly one terminal single-widget Tx field from an alias-free
passive classic AcroForm PDF. The request binds the current source SHA-256 and
returns one canonical BOM-prefixed UTF-8 CSV row without retaining an artifact.
The admitted field graph is at most two edges deep; PDF strings must be
printable ASCII or bounded NFC UTF-16BE, and formula-leading cells after
whitespace fail closed. Import, FDF, XFDF, XML, multiple or non-text fields,
calculations, actions, XFA, signatures, PDF mutation, implementation paths, and
network delivery remain excluded. Dedicated source-bound, hostile-PDF, and
lifecycle tests cover digest drift, descriptor-hostile inputs, cancellation,
private-copy tampering, cleanup aggregation, inherited fields, strict string
decoding, active content, ambiguous graphs, and response suppression.
Aggregate verification passed 2,907 tests with 2,905 passes, 2 intentional
skips, and no failures across 614 test files, 1,020 reachable production
modules, and all 318 closed capability-proof records.

## R05 Signing and security trust

Priority P1. Keep electronic intent records, certificate integrity, certificate
trust, identity custody, encryption, and enterprise policy as separate claims.

Partial (0): None.

False (16): `sign.routed-workflow`, `sign.audit-trail`, `sign.timestamp`,
`sign.certify-document`, `sign.trust-store`, `sign.revocation-ltv`,
`sign.visible-appearance`, `sign.digital-id-management`,
`sign.batch-sign-seal`, `sign.identity-verification`,
`security.certificate-encryption`, `security.policy-controls`,
`security.security-envelopes`, `security.information-protection-labels`,
`security.protected-view`, `security.encryption-aes`.

Verified closure (2026-08-03): sign.electronic is an authenticated local
consent-intent record bound to the source digest and workspace revision, with
only signer and intent hashes retained. sign.validate-certificate reports
Poppler pdfsig embedded-signature integrity and current-document coverage, plus
supported exact-CMS current-host macOS X.509 path status with certificate
fetching disabled. Both claims exclude PDF mutation, signer identity,
signing-time validity, revocation, LTV, trusted timestamps, certification
permissions, PDF-signing key usage, routing, audit trails, cross-machine trust,
external authority, and legal effect. Aggregate verification passed 2,568
tests with 2,566 passes, 2 intentional skips, and no failures across 531 test
files, 967 reachable production modules, and all 318 closed capability-proof
records.

Promotion gate: native or cryptographic authorities must be injected by the
composition root, identities must be privacy-minimal, consent explicit, signed
bytes and `ByteRange` independently validated, and trust, timestamp,
revocation, certification, and identity conclusions reported independently.

## R06 Capture, OCR, redaction, and sanitization

Priority P0. Separate hardware acquisition, recognition, human correction,
irreversible redaction, overlay labeling, and selective sanitization.

Partial (2): `scan.acquire`, `scan.duplex-feeder`.

False (1): `ocr.user-dictionaries-training`.

Promotion gate: acquisition needs real device evidence or a clear unavailable
result. OCR needs installed-engine receipts, bounded confidence evidence, and
editable or searchable output verification. Redaction must prove content
removal from retained output, not visual coverage, and publish disclosure-safe
reports without source text.

Verified progress (2026-08-05): scan.acquire now has an authenticated local
route, strict browser client contract, controller action, and bounded workflow
UI for the existing pinned ImageCaptureCore one-page flatbed PDF authority. The
route supplies the fixed profile, revalidates the source-free retained document
and provenance, exposes no paths or raster bytes, and revokes the trusted output
when cancellation or disconnection occurs before delivery. The claim remains
partial because this environment had no compatible scanner with which to record
either a real acquisition or the explicit hardware-unavailable result through
the shipped surface. Duplex, feeder, and multi-page acquisition remain excluded.

Verified closure (2026-08-03): The sensitive-pattern scan is a read-only,
authenticated source-bound scan of extracted text from one immutable PDF. Local
email, phone, Luhn-valid payment-card, and up to 20 bounded custom literal or
restricted-regex patterns return at most 500 page/character-range candidates
without matched text. The service, route, client, contract, and source-bound
claim tests verify source revalidation, bounded failures and cancellation, and
disclosure-safe results. OCR, semantic classification, marking, redaction
application, and content removal remain excluded.

Verified closure (2026-08-03): redaction.preview stores one source-digest- and
workspace-revision-bound proposed-not-applied plan for 1–64 explicit full-page
or normalized CropBox regions with a geometry-only report. redaction.batch
performs one atomic verified closed full-page operation over 1–32 unique
ascending pages in one retained source-bound PDF and separately verifies the
artifact. sanitize.selective-content removes exactly one eligible annotation by
page, index, subtype, and fingerprint in a retained source-bound PDF and proves
the reachable annotation delta. These claims exclude source-text retention,
metadata and attachment cleanup, JavaScript, layers, forms, prior revisions,
pattern/rule or multi-document batching, and orphan-byte scrubbing.
Aggregate verification passed 2,615 tests with 2,613 passes, 2 intentional
skips, and no failures across 546 test files, 975 reachable production modules,
and all 318 closed capability-proof records.

Verified closure (2026-08-03): sanitize.hidden-data is narrowed to the bounded
classic single-revision sanitizer. The authenticated route and local command
bind the exact source digest, privately stage the source, remove the admitted
hidden-data classes, retain the visible page-content digest, promote and reread
a separate artifact, and independently reinspect the result. Failed,
unavailable, unauthorized, stale, tampered, or cancelled work fails closed and
leaves no staged workspace. Encrypted, incremental, compressed,
nonzero-generation, signed, or ambiguous graphs, secure erasure, and broad
visual, semantic, accessibility, or legal equivalence are excluded. The
combined claim, route, command, service, and professional-boundary gate passed
16 tests.

Verified closure (2026-08-03): redaction.overlay-labels creates one separate
artifact by applying a verified closed full-page redaction to one page of an
immutable source-bound classic passive PDF, then storing one 1–40 character
FreeText label annotation at a fixed rectangle. The source remains unchanged.
Appearance rendering, fill, color, code sets, positioning controls, region
redaction, whole-document sanitization, conformance, and signature preservation
are not claimed. The service, route, contract, local endpoint, service test,
route test, client contract test, and source-bound claim test provide the
retained proof.

Verified closure (2026-08-04): seven OCR claims use installed Poppler,
Tesseract, and optional ImageMagick cleanup through source-bound pipelines.
Searchable OCR verifies the retained source before and after processing,
validates the derived text layer, rereads promotion metadata against the
authoritative retained artifact, and revokes mismatches. Language support is
limited to installed-pack enumeration and explicit selection; automatic
detection is excluded. Typed non-overlapping normalized zones produce bounded
TSV hierarchy and verified ALTO coordinate evidence. Table recognition is a
review-only alignment heuristic with formula-safe CSV, not authoritative table
structure. Batch OCR processes one through eight retained PDFs sequentially
under aggregate quotas with ordered source-bound outcomes. Layout exports are
limited to strict JSON, passive positioned HTML, verified ALTO, and review CSV,
without original-font, semantic, editable-layout, or visual-fidelity claims.
Screenshot OCR accepts exactly one clipboard PNG, uses a temporary one-page PDF,
verifies the OCR artifact digest, and cleans the temporary input, document, and
artifact; OS screen-region capture is excluded. Source drift, hostile engine
output, forged promotion, cancellation, malformed geometry, quotas, and cleanup
failure fail closed.

## R07 Comparison and accessibility

Priority P0. Comparison claims require two immutable sources. Accessibility
claims should follow inventory, proposal, repair, retained artifact, and
independent semantic reinspection as one traceable workflow.

Partial (2): `accessibility.auto-tag`, `accessibility.color-contrast`.

False (1): `compare.cross-format`.

Promotion gate: comparison outputs must bind both source digests and distinguish
semantic from raster evidence. Accessibility repair must preserve explicit
human decisions, align inventory and repair schemas, reread retained bytes,
and avoid PDF/UA claims without authoritative conformance validation.

Verified closure (2026-08-05): compare.overlay is narrowed to one paired page
from exactly two verified immutable local PDFs. Poppler renders both pages at
fixed 72 dpi; the service decodes them under bounded byte and pixel limits,
requires equal rendered dimensions, and returns a digest-bound in-memory PNG
with primary ink in red and secondary ink in cyan at bounded opacity. Source
digests are rechecked after rendering, rotated-page dimensions are validated,
and the client independently checks canonical Base64 plus the bounded PNG
structure and deflate stream. Alignment or registration, retained artifacts,
multipage composites, cross-format conversion, semantic equivalence, PDF/UA,
and other conformance claims remain excluded. The generic professional handler
is intentionally absent; the authenticated comparison route is the shipped
surface.

Verified closure (2026-08-05): compare.side-by-side is narrowed to one page
present in exactly two verified immutable local PDFs. Poppler renders both
pages at fixed 72 dpi; the service decodes each pane, losslessly canonicalizes
it to bounded RGBA PNG bytes, re-decodes it, and returns ordered primary-left
and secondary-right digest-bound in-memory receipts. Both source records are
reread after rendering, and the browser client independently checks canonical
Base64, PNG structure and deflate data, geometry, digest, byte size, order,
page, dpi, semantics, and source identities before the UI displays two labeled
panes. Synchronized navigation, scaling or normalization, alignment or
registration, retained artifacts, multipage galleries, cross-format
conversion, semantic equivalence, and conformance remain excluded. The generic
professional handler is intentionally absent; the authenticated comparison
route is the shipped surface.

Verified closure (2026-08-03): accessibility.remediate-tags is narrowed to one
explicit bounded canonical tagged-PDF plan on an admitted immutable passive or
classic PDF. The writer stages a private source copy, retains a separate
digest-bound artifact, independently re-inspects the output, and proves source
prefix and content-stream preservation. It does not claim PDF/UA, inferred
reading order, or whole-document semantics. accessibility.reading-order is
narrowed to existing-structure mode with an explicit complete sibling-reorder
plan, separate retained artifact, and full tag-tree reinspection; it does not
infer order or claim semantic correctness or PDF/UA conformance.

Verified closure (2026-08-03): accessibility.document-language-title is
narrowed to append-only Catalog language and Info title metadata for a passive
unsigned PDF. The shipped route and local command bind the exact immutable
source digest, promote and reread a separate artifact, validate the raw metadata
and provenance, and use Poppler to preserve page text, geometry, and fixed-size
renders. Failed, malformed, stale, disconnected, copy-failed, or cancelled
delivery revokes the retained artifact. Content-item language, tags, structure
trees, PDF/UA or WCAG conformance, sanitization, and signature preservation are
excluded. The combined claim, service, route, and command gate passed 14 tests.

Verified closure (2026-08-03): accessibility.check is proven only as one
immutable-source, read-only basic local review capped at 200 pages. It combines
bounded Poppler evidence with optional PDFKit inventory, re-verifies the source,
and returns fixed heuristic checks plus proposed-not-applied remediation
candidates without page text, source paths, image content, or PDF bytes. It does
not mutate the PDF or claim semantic, PDF/UA, or other conformance validation.
accessibility.report-export is proven only as the browser's client-side JSON
download of that exact source-bound report. It retains no host artifact and does
not export CSV or PDF, mutate the source, or claim semantics or conformance.
The R07 source-bound claim gate records positive and negative assertions for
both capabilities.

Verified closure (2026-08-03): four accessibility subclaims are proven only
within the immutable-source basic local review boundary capped at 200 pages.
heading-list-structure reports bounded Poppler heading/list role heuristics and
proposal-only warnings; artifact-management reports the standard Artifact-role
count/inventory as always not-checked and proposal-only; and
font-unicode-mapping reports bounded Poppler pdffonts ToUnicode and embedding
yes/no/unknown evidence with proposal-only candidates. accessibility.alt-text
exports one current-review image locator with explicit human-authored trimmed NFC
text of 1–1000 UTF-16 code units bound to the source digest, review digest, and workspace
revision. None mutates a PDF or proves reading order, semantics, glyphs,
decorative/repeated classification, meaning, PDF/UA, or other conformance.
The review-subclaim and alt-text proposal tests plus their route, service,
contract, and endpoint modules provide the verified positive and negative
evidence.

Verified closure (2026-08-03): compare.pixel is proven only as a decoded-PNG
raster comparison of selected or all paired pages from exactly two verified
immutable local PDFs, capped at 200 pages and 36–240 dpi. It returns
digest-bound difference PNGs, per-page metrics, and unpaired-page reports, with
no threshold or alignment controls, retained artifact, semantic equivalence, or
conformance claim. compare.annotations compares only local WorkspaceStateStore
annotation-namespace snapshots by entity ID for exactly two verified immutable
document sources; embedded PDF annotations, XFDF, rendered appearance, and
external collaboration are excluded. compare.batch runs sequential fail-closed
content or pixel comparison for 1–8 explicit document pairs, independently
verifying both immutable sources for each pair and returning pair-bound
receipts; parallel/distributed execution, cross-format mode, partial success,
and retained packages are excluded. The source-bound claim tests plus route and
client contract tests record positive and negative assertions for all three.

## R08 Standards, preflight, color, and print

Priority P1. Use installed veraPDF, Ghostscript, Poppler, and native services
only for the exact profiles and transformations they can prove. Do not merge
heuristic preflight with standards certification.

Partial (0): None.

False (17): `standards.pdf-a`, `standards.pdf-x`, `standards.pdf-ua`,
`standards.pdf-e`, `standards.pdf-vt`, `standards.pdf-two`,
`preflight.fixups`, `preflight.certified-pdf`, `color.spot-colors`,
`print.output-preview`, `print.separations`, `print.ink-coverage`,
`print.overprint-preview`, `print.soft-proof`, `print.trapping`,
`print.variable-data`, `print.barcode-decoration`.

Verified closure (2026-08-03): preflight.profiles and preflight.reports run
exactly the fixed print-review and archive-review profiles through bounded local
PdfService/Poppler inspection. Each source-digest-bound schema-v1 report is
deterministic, fixed-order, and integrity-digest bound, with capped inspection
disclosing incomplete coverage. The profiles and exports are non-authoritative
and non-certifying; no fixups, custom/imported/editable profiles, PDF reports,
certification, standards conformance, press/RIP approval, persistence, or
mutation is provided. OutputIntent/ICC and print spot/trapping/overprint
semantics remain not-checked. Profile evidence is shipped through the
authenticated prepress route; report evidence is shipped through the strict
prepress CLI JSON/XML export.

Verified closure (2026-08-03): color.convert retains a fixed host-profile
Ghostscript CMYK-targeted derived PDF with source/provenance/page/box/text/all-
page-render/artifact digest validation. It does not claim PDF/X, GWG, or press
certification; existing DeviceCMYK is not retargeted, Separation and DeviceN
are preserved, and no OutputIntent is assigned. color.output-intents retains
a separate admitted classic/passive PDF with exactly one fixed host CMYK
GTS_PDFX OutputIntent, structural/profile digest checks, and page
geometry/text/all-page-render/artifact validation; it makes no PDF/X,
colorimetric, press, or RIP claim. print.bleed-marks retains a separate
source-prefix-preserving passive PDF with deterministic black crop marks on
selected eligible pages matching existing TrimBox/BleedBox margins; it does
not provide registration/color bars, trapping, imposition, or PDF/X.
print.imposition retains fixed 2x1/2x2 upper-left row-major N-up for uniform
unrotated zero-origin geometry with marks false, validated by source/sheet
geometry, text, all-sheet render, and artifact digest checks; booklet,
signature, creep, gutter, step-repeat, marks, unconditional vector
preservation, and PDF/X are not claimed. Production authority and independent
validation are recorded by the prepress and printer-marks services, writers,
professional-capability delivery, authenticated routes and clients, applicable
CLI commands, and the focused R08 source-bound, route/client, service, writer,
and professional delivery tests.

Promotion gate: every inventory record must bind the authoritative source
digest. Mutations require outer-wrapper revocation after promotion, installed
engine execution, retained output rereading, and semantic evidence appropriate
to the claim. Conformance claims require an authoritative versioned validator.

Verified closure (2026-08-03): the two source-bound print inspection claims
were promoted after dedicated professional operation, strict Poppler resource
parser, authenticated route and client contract, installed Poppler/parser, and
focused route/client evidence. Font inspection is limited to a bounded local
font inventory with embedding, subsetting, and Unicode evidence. Image review
is limited to a bounded local image inventory with geometry, encoding, x/y PPI,
and a fixed 150-PPI review threshold. Neither surface mutates source content,
recompresses images, converts outlines, or certifies press suitability or
conformance.

Verified closure (2026-08-03): one fixed local Ghostscript pdfwrite rewrite at
compatibility level 1.3 now creates a separate source-digest-bound retained PDF
for transparency flattening. The authenticated route validates source
provenance, retained output digest and size, and unchanged page count against
the retained DocumentStore copy before responding. Deterministic retained-path
race and response-lifecycle revocation regressions fail closed. The receipt
reports flattening as unverified and remains non-authoritative and uncertified;
no separate preview, conformance validation, or press-suitability certification
is provided.

## R09 Collaboration, automation, integrations, and administration

Priority P1. Keep durable local collaboration and automation independent from
network connectors, identity administration, deployment, licensing, and
organizational reporting.

Partial (10): `collaboration.real-time-review`,
`collaboration.activity-notifications`, `collaboration.version-history`,
`dms.repository-connectors`, `dms.checkin-checkout`,
`dms.conflict-resolution`, `dms.document-locking`,
`integrations.cloud-storage`, `integrations.cad-bim`,
`integrations.sensitivity-labels`.

Verified closure (2026-08-03): automation.javascript is proven only as an
OS-local declarative recipe admission surface. `automation-run-recipe` commits
a digest-verified PDF to an explicit existing private automation root, selects
one of three immutable version-1 host recipes, and admits up to four fixed
preset jobs to the durable local queue with source+recipe-bound deterministic
occurrence idempotency. It accepts and executes no JavaScript, scripts,
imports, expressions, arbitrary operations, or caller code; authority is
invocation-scoped and fixed. Recipe execution records and receipts are not
durable history, released source and job state survive restart, and processing
requires a separate `automation-run`. Focused independent audit evidence
passed 46/46 tests across the recipe parser, fixed authority, command,
integration, automation-js, professional-capability, and professional-entrypoint
suites. Aggregate full verification is not claimed by this closure.

Verified closure (2026-08-03): automation.conditional-workflows is proven
only as an OS-local declarative workflow-admission surface. `automation-run-
conditional` reads one bounded JSON workflow, commits one digest-verified PDF
to an explicit existing private automation root before admission, evaluates at
most 8 normalized steps over verified local document and workflow facts,
selects fixed true or false branches with repeats from 1 through 4, and admits
at most 16 existing allowlisted local jobs. Canonical source-and-workflow
occurrence identities provide durable clean-restart replay idempotency.
Authority is fixed and invocation-scoped. Scripts, caller code, imports,
dynamic expressions, arbitrary operation payloads, and network execution are
not accepted. Released source and job state are durable; service workflow
records and history are session-scoped; processing requires a separate
`automation-run`. Evidence covers the shipped `scripts/platen-cli.mjs`
entrypoint, current conditional runtime, contract, service, authority,
command, and parser modules, plus the conditional parser, authority, command,
CLI integration, workflow, and professional-capability tests, including the
cancellation regression in `tests/automation-conditional-workflow.test.js`.

Verified closure (2026-08-03): admin.policy-configuration is proven only as a
dedicated OS-local CLI policy surface. It shows or sets one explicit private
policy root and one v1 boolean, default denied, controlling plugin package
install, activation, and rollback; plugin package listing remains read-only.
The canonical digest-bound state is capped at 64KiB, uses a 0700 root and 0600
single-link state, performs stable no-follow identity-bound reads, cooperative
cross-process serialization, reload-under-lock CAS, same-value replay
idempotency, revision exhaustion checks, file-fsynced atomic replacement, and
directory fsync where supported. A committed rename with unconfirmed
durability returns an explicit uncertain outcome. Restart validation and
disclosure-safe receipts are included. admin.plugin-package uses the same root
and reload/checks before install, activation, or rollback. Network, plugin
runtime execution, uploads, remote integrations, identity or roles,
organization-wide policy, generic HTTP/server operation without an explicit
policy root, and arbitrary flags are excluded. Focused evidence covers the
shipped scripts/platen-cli.mjs entrypoint, production and professional CLI
parsers, admin-policy command and authority, local application composition,
plugin-package store, and the dedicated authority, CLI integration,
enforcement, parser, and plugin wiring tests.

Verified closure (2026-08-04): admin.audit-telemetry is proven only through
dedicated OS-local CLIs using the same explicit private policy root. Successful
admin.policy-configuration set and admin.plugin-package install, activate, and
rollback commands append bounded action, subject, outcome, event identity,
sequence, previous hash, event hash, and explicitly untrusted local timestamp
records to a canonical version-1 digest-bound hash chain. The authority limits
state to 1 MiB and 4,096 records, enforces a 0700 root and 0600 single-link
state file, performs stable no-follow identity-bound reads, serializes and
reloads state under a cooperative cross-process lock, treats matching event
identity and payload as idempotent and drift as conflict, uses file-fsynced
atomic replacement with directory fsync where supported, verifies the owned
temporary FD against the final pathname after rename, reports committed
persistence uncertainty explicitly, validates state across restarts, and
exposes at most 100 recent immutable records without filesystem paths. Generic
professional-capability delivery and arbitrary caller events are rejected.
The bounded claim excludes general document-operation telemetry, monitoring,
remote export, identity or role attribution, trusted timestamps, HTTP or server
instances without an explicit policy root, and guaranteed audit retention when
a mutation commits but its later audit append fails. Focused evidence covers
the shipped CLI parsers and commands, audit authority, local composition,
professional boundary, and independent authority, integration, boundary,
CLI, plugin-wiring, and reachability tests.

Verified closure (2026-08-02): automation.variables-presets is proven only as
the shipped read-only listing of three immutable, versioned host-defined preset
descriptors with typed defaults and deterministic identities. It does not
expose user-defined presets, arbitrary variables, code or expression
evaluation, or durable execution. admin.plugin-allowlist is proven through the
local CLI and publisher trust authority for Ed25519 publisher keys and bounded
plugin-ID scopes. Its private trust root uses canonical atomic persistence,
restart validation, serialized mutations, revocation or unrevocation, and
fingerprint-confirmed removal with disclosure-safe public receipts. Plugin
version policy, HTTP administration, admin-role policy, and retained actor
audit are excluded. Independent claim tests cover exact preset identity and
immutability plus trust-root permissions, restart recovery, replay behavior,
redaction, corruption, link attacks, revocation, and removal. The same audit
No additional local claim remains partial; admin.audit-telemetry now has the
bounded closure recorded above, while the remaining partial claims stay in the
external-adapter lane.
Aggregate verification passed 2,412 tests with
2,410 passes, 2 intentional skips, and no failures across 485 test files and
918 reachable production modules. After the R04 square-annotation promotion,
all 318 capability-proof records reconciled with no unaudited claims; the
current totals are maintained in the authority section above.

Verified closure (2026-08-07): automation.cli-batch is proven only as the
automation-submit-batch CLI admission surface for 2 through 8 distinct local
PDFs under one explicit existing private automation root. Every item uses the
same fixed allowlisted operation or immutable preset. A required caller batch
identity is domain-hashed with its stable ordinal into a bounded queue replay
key; the existing source and job matcher rejects source or operation drift.
Each identity owns appendable ordinal lanes: a shorter replay does not cancel
previously admitted trailing jobs, while an extension admits new trailing
ordinals.
Admission is serialized, each source is independently retained and committed,
and an exact rerun resumes already committed items after a partial failure.
Transient uploaded documents are deleted after each attempt, cancellation
stops before the next admission, and the final receipt omits input paths, PDF
bytes, and the raw batch identity. The command does not execute jobs, roll back
already committed items, accept arbitrary operations, run scripts, or use the
network; processing still requires a separate automation-run. The former
source-dropping generic professional handler was removed. Focused parser,
command, restart, replay, drift, cancellation, cleanup, and disclosure tests
cover the shipped CLI path and real durable queue.
Aggregate verification passed 2,930 tests with 2,928 passes, 2 intentional
skips, and no failures across 621 test files and 1,025 reachable production
modules. Local release inventory validation passed; signing and notarization
remain external evidence and were not checked.

Verified closure (2026-08-07): automation.api is proven only as the
single-document automation-submit CLI path under one explicit existing private
automation root. Each invocation creates a fixed default-deny principal and
grant, stages and digest-verifies one local PDF, and admits one fixed inspect,
OCR, output-intent, bounded full-page-redaction, immutable-preset, or
immutable-sequence selection through AutomationApiService. The service derives
the source transaction from verified metadata, validates the exact durable
queue response, reconciles ambiguous admission, and commits the accepted
source. A source whose post-admission commit is uncertain remains staged and is
reconciled on the next cleanly opened invocation. Receipts expose bounded
source and public job metadata without paths or PDF bytes. The generic
professional-capability CLI and host dispatcher deny this capability. HTTP or
network transport, scripts, arbitrary payloads or operations, job execution,
general administration, cross-process API ownership or status, custom OCR,
batch admission, and automatic stale-lock recovery after abrupt process death
are excluded. Independent promotion evidence passed 98/98 focused tests,
including every fixed API selection, hostile values, exact replay and drift,
ambiguous admission, commit uncertainty, clean-open recovery, generic-boundary
denial, and source-inventory reachability.
Aggregate verification passed 2,940 tests with 2,938 passes, 2 intentional
skips, and no failures across 624 test files and 1,027 reachable production
modules. Local release inventory validation passed; signing and notarization
remain external evidence and were not checked.

False (20): `collaboration.share-links`, `collaboration.access-expiration`,
`collaboration.projects-workspaces`, `dms.retention-records`,
`dms.offline-sync`,
`automation.webhooks`, `automation.preflight-server`,
`automation.batch-print`, `integrations.office-addins`,
`integrations.browser-capture`, `integrations.email`,
`integrations.esign-providers`, `integrations.events-webhooks`,
`admin.identity-roles`, `admin.sso-scim`, `admin.deployment-packaging`,
`admin.update-management`, `admin.licensing`, `admin.data-residency`,
`admin.usage-reporting`.

Promotion gate: local records need durable ownership, authorization, replay
protection, restart recovery, cancellation, and bounded reporting. External
claims require an explicit trusted adapter, credential boundary, network
allowlist, idempotency, redacted receipts, and live integration evidence.

## R10 AEC workflows

Priority P0. These claims already have bounded local geometry and revision
building blocks. Split workers by measurements, markup records, sheet sets,
revision workflows, offline projects, and geospatial evidence.

Partial (0): None.

False (0): none.

Promotion gate: calibration, measurements, records, legends, and materialized
PDF artifacts must share the same document digest and workspace revision.
Geometry must be finite, bounded, non-degenerate, and independently inspected;
revision and offline claims need durable restart and conflict evidence.

Verified closure (2026-08-02): aec.scale-calibration records exactly one
selected-page, two-point scale against the current source digest and workspace
revision, with finite non-degenerate geometry, bounded units, stale-operation
suppression, and cancellation-safe state. aec.legends exports only validated
current-revision measurement groups through the authenticated route, browser,
or exclusive CLI output. It caps records at 500, rejects duplicate identity or
provenance, groups deterministically, and replaces raw measurement labels with
SHA-256 digests. Neither claim mutates the PDF or expands into multi-viewport
calibration, inferred geometry, dynamic markup symbols, or collaboration.

Verified closure (2026-08-02): aec.takeoff aggregates 1–100 unique
current-source distance, perimeter, area, or count measurements at the current
optimistic workspace revision into deterministic grouped SI quantities and
digest-bound provenance. aec.markups-list creates and lists current-source
workspace markups with bounded type, status, and page filters, deterministic
ordering, and deterministic summaries. Both authenticated browser workflows
reject forged source digests and stale revisions and suppress stale or
cancelled completion. They do not price, evaluate formulas, collaborate,
inspect or mutate PDF annotations, or mutate the PDF.

Verified closure (2026-08-02): aec.sheet-metadata-tags creates one manually
authored, current-source page record with a bounded sheet number, title, and up
to 50 tags at the current optimistic workspace revision. It does not extract
metadata, infer discipline or revision tags, report, synchronize, or mutate the
PDF. aec.offline-projects exports and imports a self-contained local bundle
through the authenticated browser surface with exact PDF bytes and an
integrity-checked workspace snapshot. Import rebases to a fresh local revision
and appends a replace audit event; malformed framing, tampering, source drift,
stale export completion, and cancelled import completion fail closed. Network
synchronization, multi-user collaboration, automatic conflict resolution, and
remote repositories remain excluded.

Verified closure (2026-08-02): the authenticated spaces and regions workflow
stores one named space or region on a declared page against the current source
digest and optimistic workspace revision. It accepts 3–200 finite PDF-point
coordinates, rejects repeated vertices, degenerate area, and self-intersection,
and stores deterministic six-decimal area and perimeter metrics. It does not
inspect page boxes, mutate the PDF, infer geometry, report, or collaborate. The
revision-status workflow creates a current-source local draft and permits only
the issued and superseded transitions in order. Source provenance and basis
revision survive each transition and portable local project transfer. Forged
or stale requests and invalid transitions fail closed; network collaboration,
PDF artifacts, remote synchronization, automatic conflict resolution, and
multi-user review remain excluded.

Verified closure (2026-08-02): source-bound custom columns accept one manually
authored safe arithmetic expression over 1–32 variables and evaluate one exact
bounded numeric row without mutating workspace state. Source-bound affine page
coordinates retain one manually authored bounded calibration and convert one
bounded point deterministically. Both paths require the current document digest
and optimistic workspace revision. They do not claim pricing, inferred columns,
arbitrary JavaScript, GeoPDF or CRS interpretation, geodesy, map layers, PDF
mutation, reporting, or collaboration.

Verified closure (2026-08-02): aec.markup-toolsets persists a source-bound tool registry
with its source digest and basis revision; aec.revision-overlay persists a
source-bound descriptor-only link between distinct revisions; and
aec.batch-slip-sheet persists a source-bound slip-sheet plan with unique sheet
pairs. These narrow records exclude markup creation, overlay rendering or
alignment, page replacement, carry-forward, PDF mutation, and remote
collaboration.

Verified closure (2026-08-02): aec.collaborative-review-sessions stores one
local review-session descriptor with a bounded workspace identifier and 1 to
50 unique participant identifiers against the current source digest and
optimistic workspace revision. aec.measurement-toolset reads only the exact
shipped distance, perimeter, area, and count catalog with deterministic
dimension and SI-unit metadata and does not persist state. aec.sets-drawing-log
stores one local drawing set with 1 to 100 unique sheet identifiers and exactly
one initial bounded revision-label and valid ISO-date log entry. Authenticated
browser routes reject forged source digests, stale revisions, extra fields,
malformed identifiers, duplicate entries, invalid dates, and oversized inputs
without changing the workspace or source PDF. Network collaboration, remote
identity or synchronization, quantity computation, volume, angle, radius,
sheet extraction or reordering, automatic revision inference, later log
lifecycle, and PDF mutation or materialization remain excluded. The focused
feature, facade, template, browser, reachability, catalog, proof, prototype,
and ledger gate passed 56 tests with 0 failures. Aggregate verification passed
2,376 tests with 2 explicit skips and 0 failures across 915 reachable
production modules.

## R11 Portfolios, rich media, 3D, and geospatial

Priority P2. Treat portfolio containers, embedded files, optional-content
groups, media playback, 3D geometry, articles, and geospatial documents as
different native feature sets.

Partial (4): `portfolios.create`, `portfolios.view-extract`,
`portfolios.metadata-search`, `portfolios.custom-layout`.

False (8): `rich-media.audio-video`, `rich-media.playback-controls`,
`three-d.import`, `three-d.saved-views-sections`, `three-d.measure-comment`,
`document.article-threads`, `document.optional-content-groups`,
`geospatial.inspect-measure-markup`.

Promotion gate: container inventories must be bounded and source-bound;
extraction must verify retained bytes and safe names. Media, 3D, layer, article,
and geospatial claims require actual native parsers or renderers and must not be
inferred from raw token searches.

Verified closure (2026-08-04): document.embedded-files is narrowed to a
privacy-minimal read-only inventory of one immutable retained PDF. It reports
bounded count, aggregate size, ordinal, optional page locus, byte size, and
SHA-256 while omitting names, paths, text, object references, and payload bytes.
The source is verified before and after parsing and remains unchanged.
Malformed or cyclic Filespec graphs, source drift, cancellation, size bounds,
hostile request bodies, and forged client fields fail closed. Extraction,
authoring, export, removal, playback, and payload safety are excluded.

## R12 AI policy exclusions

Priority P3. These remain deliberate false claims while the product policy is
local deterministic processing without generative AI. Agents must not create
mock AI output or promote deterministic keyword utilities under AI names.

Partial (0): none.

False (15): `ai.summarize`, `ai.ask-document`,
`ai.extract-structured-data`, `ai.translate`, `ai.rewrite-proofread`,
`ai.explain`, `ai.source-citations`, `ai.multi-document-analysis`,
`ai.generate-images`, `ai.generate-bookmarks`, `ai.smart-redaction`,
`ai.form-extraction`, `ai.accessibility-suggestions`,
`ai.annotation-assist`, `ai.provider-policy-controls`.

Promotion gate: none under current policy. Any future change requires a product
decision, local model or approved provider boundary, privacy and consent rules,
source citations, prompt-injection handling, deterministic failure behavior,
and a new proof plan before implementation begins.

## Recommended agent order

`READY` means discovery may start. It does not authorize overlapping edits or
promotion. `CONDITIONAL` requires the named authority. `HOLD` requires a product
or external dependency decision before implementation work. `CLOSED` records a
completed queue item and is not new work.

| Order | Queue item | Initial state | Required exit before advancing |
| ---: | --- | --- | --- |
| 0 | Reconcile manifest and reserve exact files | READY | Counts match and ownership is disjoint |
| 1 | R03 remaining false claims and shared PDF mutation rules | CONDITIONAL on distinct flatten or PDF-native resize authority | Source-bound mutation, reread, digest, cancellation, and reinspection contract accepted |
| 2 | R04 remaining false review, annotation, and forms claims | CONDITIONAL on R03 rules | Per-effect annotation evidence and AcroForm round-trip validation |
| 3 | R06 redaction and sanitization claims | CLOSED | All redaction and sanitization claims are proven within explicit source-bound boundaries |
| 4 | R07 partial accessibility claims | CONDITIONAL on R03 rules | Inventory-to-repair closure and independent semantic reinspection |
| 5 | R10 AEC partial claims | CLOSED | All R10 claims are proven within explicit local-only boundaries |
| 6 | R02 remaining conversion claims | READY when the missing engine or heterogeneous-input authority is named | Retained artifacts reread and bounded fidelity checked for each remaining format |
| 7 | R06 scanner acquisition and OCR training remainder | CONDITIONAL on hardware or persistent training authority | Real device evidence or durable trained-language authority with deterministic unavailable behavior |
| 8 | R07 comparison false claims | CONDITIONAL on two-source digest authority | Both sources bound, page mapping deterministic, report evidence exportable |
| 9 | R01 plugin RPC, permissions, and runtime sandbox | HOLD pending enforced isolation authority | Authenticated RPC, enforced permissions, OS isolation, and adversarial escape evidence |
| 10 | R05 remaining false signing and security claims | CONDITIONAL on native identity authority | Explicit consent, source digest, certificate status, and trust limitations verified |
| 11 | R08 remaining false standards, preflight, color, and print claims | CONDITIONAL on installed conformance or print engine | Post-promotion reread plus conformance or print-output evidence |
| 12 | R09 local durable-state partial lane | CLOSED | Authorization, idempotency, replay recovery, retention, and processing reports proven |
| 13 | False claims in R01 through R10 | CONDITIONAL on the matching shared authority | Each claim implemented through that authority or retained false with an exact blocker |
| 14 | R09 external-adapter lane | HOLD | State owner, authorization model, vendor adapter, and external test environment named |
| 15 | R11 specialized containers and media | HOLD | Native container, media, 3D, or geospatial dependency approved |
| 16 | R12 AI exclusions | HOLD | Product, privacy, provider, citation, and prompt-injection policies approved |

For one implementation agent, follow the table strictly from top to bottom and
skip only `CONDITIONAL` or `HOLD` rows whose prerequisites are unavailable. Do
not treat a skipped item as complete.

For parallel remediation, R02 may run alongside R03 when its engine and file
ownership are independent. After R03 exits, R04, the destructive portion of
R06, the accessibility portion of R07, and R10 may run concurrently with
disjoint owners. R01, R05, R08, and R09 local may run concurrently only after
their respective authorities and exact file lists are accepted.

R09 local means `automation.api`, `automation.cli-batch`,
`automation.variables-presets`, `admin.audit-telemetry`,
`admin.plugin-allowlist`, and the proven `admin.policy-configuration` surface.
Its other partial
claims belong to the external-adapter lane.

Within a program, the orchestrator may bundle claims sharing one durable
authority into one implementation packet. The audit matrix and promotion
decision remain separate for every capability ID.

## Ledger maintenance

After each accepted promotion or deliberate scope change:

- remove the capability from this ledger or regenerate the affected lists;
- preserve exact partial and false totals;
- record unresolved external evidence separately from local failures;
- do not mark a program complete while any listed ID remains non-proven;
- rerun an exact closure check against the proof manifest.

The ledger is complete only when its listed IDs equal the set of proof records
whose status is `partial` or `false`, with no duplicates and no proven IDs.
