# Architecture

## Current system

Platen is a browser GUI backed by a same-origin local Node host. The
host is an execution boundary for trusted built-in adapters, while the future
third-party plugin boundary remains deliberately disabled.

```text
Browser GUI
  ├─ DocumentSession ── source Blob URL ── browser-native PDF viewer
  ├─ ControlledRasterSession ── one selected-page PNG Blob URL ── passive image
  ├─ DocumentOperationCoordinator: generation/cancellation/download lifecycle
  ├─ editor readiness + evidence views: pure immutable render inputs
  ├─ LocalHostClient ── token + same-origin requests ─────────────┐
  └─ CapabilityRegistry ── catalog and plugin planning views      │
                                                                  ▼
Authenticated loopback host (127.0.0.1)
  ├─ DocumentStore/InputAssetStore: immutable sources, SHA-256, artifacts
  ├─ WorkspaceStateStore + DomainFacade: revisioned local workflow sidecars
  ├─ ProjectBundleService: canonical and self-contained workspace portability
  ├─ EngineRegistry: fixed absolute paths and version probes
  ├─ ProcessRunner: argv only, no shell, shared queue, limits, cancellation
  ├─ AutomationSourceStore + DurableLocalJobQueue: private sources, journal, retry
  ├─ PdfService façade
  │    ├─ PdfInspectionService: evidence, text, resources, signatures, renders
  │    ├─ PdfCompositionService: validated page selection and composition
  │    └─ PdfOcrService: serialized OCR document, batch, and layout jobs
  ├─ ConversionService: creation, conversion, and validated rewrites
  ├─ RasterMutationService: destructive derived raster edits/redaction
  ├─ ComparisonService: bounded content, pixel, and sidecar comparisons
  ├─ PrepressService: bounded review, CMYK-targeting, N-up, and receipts
  ├─ AecArtifactService: calibrated local measurements and optional annotations
  ├─ PdfIncrementalMetadataService: append-only classic-xref Info edits
  ├─ PdfIncrementalGoToLinkService: append-only direct local-page links
  ├─ PdfIncrementalNamedDestinationService: append-only direct /Fit destination
  ├─ PdfJavaScriptRemovalService: fixed one-locus closed classic rewrites
  ├─ optional PdfKitInspectionService: bounded macOS structure inventory
  ├─ optional PdfKitMutationService: validated macOS derived rewrites
  ├─ optional PdfKitProtectionService: fixed protection and owner-authorized cleartext copies
  ├─ optional PdfKitSanitizationService: fixed metadata-only derived rewrites
  ├─ route families: document-service and PDFKit dispatch behind one policy shell
  └─ trusted local adapters
       ├─ Poppler and Tesseract
       ├─ Ghostscript and ImageMagick
       ├─ LibreOffice with deterministic document-text fallbacks
       └─ a private digest-pinned Apple PDFKit release helper on macOS

PluginHost.activate() ── always fails with PLUGIN_RUNTIME_UNAVAILABLE
plugins/skeletons/* ──── declarative non-executable plans only

Strict local CLI ── descriptor-based input snapshot ── same stores/services
  ├─ no-clobber single outputs
  ├─ fixed source-free blank-PDF creation with independent validation
  ├─ named review, CMYK, N-up, and production-validation operations
  ├─ sequential manifested OCR batch
  └─ stable, direct-child-only bounded OCR watch session
```

The local verification graph starts at `src/app.js`, `scripts/serve.mjs`, and
`scripts/platen-cli.mjs`. Every JavaScript and native Swift source file is present in the
fixed release inventory. Modules under the browser, host, and CLI production
surface must be transitively reachable from those roots or remain in an exact
intentionally-unshipped list. That list currently holds the disabled executable
plugin foundations and two compatibility barrels; adding another disconnected
module, or accidentally wiring one of those foundations into production, fails
verification and local release validation.

CLI argument parsing is split between shared grammar/foundation rules and the
prepress command family. Filesystem publication/runtime policy is separate from
the document, OCR, batch, watch, and prepress command handlers, so the CLI entry
module remains dispatch-only.

The browser entry module is a composition root. Document lifecycle, viewing,
generation, OCR, raster work, page composition, comparison, review, AEC,
PDFKit, and workspace workflows live in focused controller factories whose
operation groups are separate collaborators. Click, form-change, form-input,
target, and shell event delegation live in separate UI routers; pure editor
renderers are split into shell, document, surface, review, OCR, raster, and
focused PDFKit inspector sections. Shared
document-bound generation checks, cancellation, error/finalization callbacks,
and normal versus ephemeral artifact-download lifecycle remain centralized in
`DocumentOperationCoordinator`. Inspector action gates are derived once into a
frozen readiness snapshot, and evidence renderers do not mutate availability.
DOM-free PDFKit workflow contracts build and validate bounded mutation,
local-link, line/ink, protection, and removal requests; controllers retain
confirmations and effects.

The browser host client is likewise a small facade over document, OCR, PDFKit,
JavaScript-removal, named-destination, and review endpoint families. The loopback router retains Host/token/origin/body/
error/cancellation policy, while document read, document mutation, document OCR,
PDFKit, and workflow route dispatchers receive only the services and shared
response helpers they need. Optional native services are staged outside the host
composition root. OCR request/result contracts, PDF evidence parsers, composition
executors, document stores, review/forms domains, project-bundle transfer,
accessibility review, AEC artifacts, raster mutation, prepress operations, and
PDFKit mutation and sanitization each have explicit contract, lifecycle,
execution, validation, verification, and artifact boundaries where those
responsibilities apply.

`PdfService` remains the compatibility surface used by the host and CLI. Its
inspection, composition, and OCR implementations are separate collaborators.
Shared limits, evidence parsers, page-selection contracts, output/workspace
guards, and OCR helpers are acyclic leaf modules re-exported by the façade, so
callers retain the existing parser API without collaborators importing their
own façade.

The durable automation lane is separate from the in-memory native-process
limiter and currently executes exactly one built-in operation:
`automation_inspect_v1`. The CLI uploads through the ephemeral `DocumentStore`,
then an application-scoped transaction serializes admission, private
descriptor-copy staging, digest binding, enqueue, and rollback. The durable
journal retains only the opaque source ID and digest. A queue root has one live
owner and a private canonical version-1 journal bound to an exact job-type
allowlist and limits policy. Mutations are durably replaced after validation;
idempotency conflicts, leases, renewal, expiration, cancellation, fixed
classified retry, restart recovery, clock rollback, and bounded immutable
receipts fail closed. General job inspection never returns the active lease
token. Active work is cancelled through the worker process's signal. A separate
CLI process can cancel pending work only when it can acquire the root. Graceful
close releases ownership. An unclean exit deliberately leaves the ownership
lock in place: there is no unsafe automatic stale-lock deletion. The default
store is finite: terminal jobs still count against 256 queue records, while
sources are capped at 256 records, 512 MiB each, and 2 GiB total. There is no
retention or purge workflow. The invoking OS user and private root path are the
authority; there is no HTTP route, separate token, scheduler, action sequence,
script evaluator, or arbitrary executor, so this is not complete automation.

`PdfIncrementalMetadataService` is a separate pure-JavaScript mutation
boundary, not a PDFKit route. Its fixed
`local-classic-incremental-metadata-v1` contract accepts exactly Title, Author,
Subject, and Keywords. The profile name records its classic appended revision;
the source may use the bounded classic-xref or xref/object-stream forms. A bounded
parser follows at most 31 source `Prev` revisions and 50,000 aggregate xref rows, shares a 100,000-node AST
budget and 8 MiB decoded-string/name budget across every trailer and object,
parses every xref-listed top-level object with direct stream lengths, proves
object and xref/trailer spans do not overlap, and rejects repair ambiguity,
encryption, unsupported hybrid or control-stream forms, catalog permissions,
and reachable XMP metadata. The writer
copies the effective Info dictionary, replaces only those four keys with
canonical UTF-16BE hex strings, allocates object `N = Size` at generation zero,
and appends a trailer with `Size N+1`, unchanged `Root`, and the prior xref in
`Prev`. An existing permanent ID is preserved while its changing ID is updated
with a domain-separated deterministic digest; an absent ID stays absent.

`PdfIncrementalAccessibilityMetadataService` is a separate fixed-profile use of
the bounded append-only engine. The GUI exposes it only for the current
immutable source after `basic-local-review` reports both document title and
document language missing. The browser and authenticated route accept exactly one
conservative lowercase language tag and one trimmed NFC title. The raw writer
requires an unsigned, unencrypted, untagged, form-free passive graph without
JavaScript, actions, attachments, URLs, XMP, optional content, annotations, or
an existing Catalog `/Lang` or Info `/Title`; it appends one replacement Catalog
and one new Info object while retaining every source byte as the exact prefix.
A separate raw reparse proves the two-row revision, Root/Info/Prev/Size/ID
policy, unchanged effective non-target rows, and exact decoded values. Private
file identity, Poppler page count, extracted text, page boxes, fixed all-page
render equality, unsigned output, source rehash, and digest-bound promotion are
required. Provenance and the public result carry only a SHA-256 of the exact
normalized language/title request; the browser recomputes it before accepting
the result. The derived artifact uses the one-shot path, which attempts deletion
after successful or failed retrieval and surfaces cleanup failures. The profile does not add content-item language, tags, a structure
tree, reading order, PDF/UA or WCAG conformance, sanitization, or signature
preservation; historical bytes and metadata remain recoverable.

The shared `pdf-classic-object-value.mjs`,
`pdf-classic-object-transaction.mjs`, and
`pdf-classic-incremental-revision.mjs` modules form a bounded general object
transaction engine. Strict compatibility exports retain the classic-xref-only
boundary for classic-only callers. Generic exports used by the metadata,
BleedBox, and AEC writers also
parse xref-stream revisions with bounded type-2 object-stream members alongside type-0/type-1
entries and emit the existing classic append with an exact `/Prev` link.
The xref-stream boundary validates bounded `/W` and `/Index` arrays, exact
decoded row length and compressed-input consumption, the control object's self
row, every physical object header, revision chronology, non-overlapping spans,
and protected control-object authority. Xref and object controls admit identity,
one ASCIIHex, ASCII85, Flate, or RunLength filter, or an exact
ASCII-plus-Flate/RunLength chain.
ASCII terminators, tuple bounds, Flate input consumption, and every allocated
intermediate are checked under a 16 MiB per-scope work budget. Decode parameters
are limited to absent, null, empty, Flate predictor 1, or bounded PNG predictors
10-15; RunLength requires exact final EOD and no non-empty parameters. TIFF,
multicolor, sub-byte, and general predictor decoding remain unsupported. Each object stream has
a strict member directory and exact value slices and participates in fixed
per-stream and aggregate byte/member budgets. Compressed entries bind only to a generation-zero container introduced
in the same revision; exact later repeats retain that authority, while later
ordinary objects may shadow a compressed member. Recompression, orphan
members, container reuse, and top-level bare-reference members are rejected.
Parser structures are branded, authoritative maps stay private, and each
resolution returns a defensive AST copy. Before returning a descriptor, the
builder validates that the effective Root remains a non-stream Catalog without
`/Perms` and that any effective Info remains a non-stream dictionary. The value boundary
snapshots own data properties and rejects accessors, symbols, cycles, sparse
arrays, incoherent number tokens, expanded alias amplification, and excessive
depth, items, decoded bytes, or serialized bytes. A transaction can update
selected existing objects and allocate deterministic contiguous generation-zero
additions from effective `Size`; branded pending references can point forward
or backward among those additions, and a new Info reference can be bound
explicitly. Records may also add or replace one opaque direct-length stream;
the transaction snapshots its bytes, canonicalizes `/Length`, digest-binds the
private record, and verifies the exact binary span after output reparse. The
builder preserves the source as the exact byte prefix, emits one append-only
xref/trailer revision, then reparses the output and revalidates all nested
references. The admitted metadata, BleedBox, AEC, local-GoTo-link, and
named-destination writers use this same
engine. A separate compact-rewrite primitive traverses the effective Root and
optional Info graph with cycle and shared-reference handling. It preserves
object numbers and generations, the admitted PDF version, existing ID bytes,
and exact opaque stream payloads while expanding reachable object-stream members
into ordinary objects. It writes one deterministic sparse classic xref, drops
prior revisions and unreachable objects, and then requires the strict closed-output
verifier to account for every non-whitespace byte and every live object. Reachable
signature evidence and xref/object-stream controls fail closed. Classic AST values
and opaque streams are general within these bounds. An internal targeted
logical-deletion path additionally accepts only opaque exact-source handles for
current ordinary uncompressed objects when the effective table completely
represents `0..Size-1` and its free list is acyclic and in range. It evaluates
the graph after applying replacements and additions, rejects surviving inbound
references by object number and all historical or planned signature evidence,
then appends a sorted object-zero-led classic free chain with incremented
generations. Its verifier rebuilds and reparses the append and checks exact rows,
effective state, the complete chain, written objects, and unresolvable targets.
The original bodies remain in the preserved prefix and freed numbers are not
reused. General stream decoding/filter semantics, hybrid references, encryption,
repair, unrestricted targeted deletion, arbitrary object discovery, profile-independent sanitization claims, and profile-independent
admission or semantic verification remain unavailable.

The host stages and revalidates an immutable private source, rejects signed or
Poppler-detected form/JavaScript/attachment/URL inputs, and requires silence
from every structural/content Poppler validation command. It reparses the
canonical tail in a separate raw reinspection, checks standard and custom Info metadata, page
count, extracted text, page boxes, every page render, unsigned output, file
identity, source immutability, and artifact digest before promotion. The exact
source prefix and all earlier revisions intentionally remain, so this path does
not sanitize historical metadata or establish broader active-content safety.

`PdfIncrementalGoToLinkService` is a platform-independent sibling boundary.
Its `local-incremental-goto-link-v1` contract accepts only source and target
page numbers plus one integer PDF rectangle. Every page leaf must provide
explicit integer MediaBox and CropBox arrays, each CropBox must be contained by
its MediaBox, and the requested rectangle must fit inside the source CropBox.
The admitted object graph is unsigned and deliberately passive: catalog/page
actions, every standard action family, forms, attachments, XMP, URLs, existing
links, and non-whitelisted or action-bearing annotations fail closed. The
transaction adds one invisible `/Annot /Link` with direct `/Dest [page /Fit]`
and no `/A`, updating only the selected page or its indirect Annots array. Its
raw verifier regenerates the canonical append, proves the exact two-row delta,
preserves all other effective entries including compressed-object provenance,
and binds Root, Info, ID policy, source prefix, and classic appended revision.
The host repeats private source/output identity checks and source hashing around
independent Poppler page-count, text, box, and fixed 256-pixel all-page render
equality plus unsigned-output inspection before digest-bound promotion. This
path preserves history by design; it is neither sanitization nor general
hyperlink, signature-preservation, semantic-equivalence, or print-equivalence
support.

`PdfIncrementalNamedDestinationService` is a separate platform-independent
append-only boundary. Its `local-incremental-named-destination-v1` contract
accepts one existing page and one exact 1–64-character ASCII name matching
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. It admits only an unsigned, unencrypted,
passive 1–100-page source with an exact empty Poppler named-destination
inventory, no Catalog `/Names` or legacy `/Dests`, explicit integer MediaBox
and CropBox arrays, and no page annotations. The transaction updates only the
Catalog with one direct `/Names /Dests /Names [(name) [page /Fit]]` entry and
preserves the source as the exact prefix. The raw verifier regenerates the
canonical append and binds the Root row, unchanged effective table, Root/Info/
ID policy, target reference, name digest, and classic revision. The host then
requires Poppler to report exactly that one local `/Fit` destination and
unchanged page count, text, boxes, and fixed 256-pixel all-page renders, plus
unsigned output, immutable source, private-file identity, and digest-bound
promotion. The name remains in the output PDF while results and provenance
retain only its SHA-256. This is not general destination management,
sanitization, or signature preservation.

`PdfJavaScriptRemovalService` is a separate platform-independent closed-rewrite
boundary. Its `local-document-javascript-removal-v1` contract accepts at most
64 MiB of classic-xref input and exactly one indirect ordinary uncompressed
document-level JavaScript locus: either Catalog `/OpenAction` or a direct
Catalog `/Names` dictionary containing one flat `/JavaScript` name-tree pair.
The action dictionary is exact `/S /JavaScript` plus one non-empty direct string
capped at 64 KiB. Other actions, `/AA`, `/Next`, forms, signatures,
attachments, XMP, URLs, tags, layers, shared targets, streams, compressed
targets, and unsupported graphs fail closed. The writer first removes the
Catalog reference and proves a generation-incremented logical-deletion append.
It then compacts the effective reachable Root and optional Info graph and
independently rebuilds the deterministic output. The final artifact has one
closed classic revision, no prior revisions or unreachable objects, no
JavaScript surfaces, and unresolvable removed references. The host binds an
immutable private source and the promoted digest around Poppler page-count,
text, page-box, fixed 256-pixel all-page render, JavaScript-absence, and
unsigned-output checks. This fixed profile is not general action editing,
JavaScript authoring or execution, hidden-data sanitization, secure erasure, or
byte/object/signature preservation.

`PdfAttachmentRemovalService` is a separate platform-independent closed-rewrite
boundary. Its `local-document-attachment-removal-v1` contract accepts at most
64 MiB of classic-xref input with one exact flat document-level embedded-file
name tree, one unshared Filespec, and one direct-length unfiltered stream capped
at 8 MiB. The matching name-tree and Filespec names must be 1–240 bytes of
printable ASCII. An optional exact `/PageMode /UseAttachments` hint is accepted
and removed. The host privately extracts attachment 1 through Poppler, rejects
warnings and unsafe or changing filesystem identities, forces mode `0600`, and
binds the name digest, content digest, and byte count without returning the
name or bytes. The writer proves a generation-incremented logical-deletion
append before compacting the reachable graph into one closed classic revision.
Independent raw reinspection requires the three removed objects to be
unresolvable and prior revisions and attachment surfaces to be absent. Poppler
then proves zero output attachments, unchanged page count, text, boxes, fixed
256-pixel all-page renders, and unsigned output before digest-bound promotion.
Actions, forms, signatures, active content, XMP, URLs, tags, shared targets,
multiple attachments, and unsupported graphs fail closed. This is not general
attachment management, user-facing extraction, or hidden-data sanitization.

`PdfCompositionService.copyPageBetweenDocuments` exposes only
`local-copy-one-page-between-documents-v1`: one page from a distinct secondary
document inserted after an exact primary page. The request binds both immutable
source digests. The executor creates descriptor-bound private mode-`0400`
copies and uses those copies for every admission, split, and semantic read. A
bounded generic-PDF graph scanner accepts classic, xref-stream, and
object-stream syntax but rejects malformed or inconsistent page trees,
catalog-level structures, outlines, optional content, annotations, and actions
before Poppler composition. Poppler independently rejects the remaining
encrypted, form, JavaScript, tag, XMP, attachment, URL, and signature surfaces.
The output page manifest contains page boxes and rotation plus NFC extracted-text
and fixed 256-pixel render SHA-256 values. Only its aggregate digest is retained
in provenance. Exact ordered manifest equality, both staged identities, both
store sources, and the promoted digest are rechecked before publication. This
is page-semantic composition, not preservation of PDF bytes, objects,
document-level structures, or signatures.

The native PDFKit helper is likewise responsibility-split. `main.swift` is a
small stdin/CLI dispatcher; request/response protocol models, strict request
validation, workspace I/O, raw document safety, page/navigation inspection,
page and form-widget mutation support, line/ink/AEC geometry, annotation
sanitization, radio/navigation mutation, protection, owner-authorized
deprotection, and metadata sanitization live in separate Swift files. Native
layout tests enforce that the entry point does not absorb those trust-sensitive
implementations again.

`tests/source-layout.test.js` guards the refactor across production code, tests,
native sources, HTML, and styles. Each covered file must remain at or below 400
physical lines and 32 KiB, and no covered source may hide a workflow on a logical
line longer than 1,000 UTF-16 code units. A token-aware symbol guard independently
limits production JavaScript and Swift functions or methods to 120 physical lines
and classes or types to 300; scanner fixtures cover multiline declarations and
ensure braces in comments, strings, templates, and regular expressions do not
distort the measurement. The companion dependency-layout test resolves every
relative JavaScript import, rejects production import cycles, and reserves the
compatibility `PdfService` facade for the host composition root. A rendered-action
contract also requires every literal `data-action` in the GUI to have exactly one
delegated application handler. Large test suites and the stylesheet are split by
behavior while retaining their public entry points. Both `npm test` and the
verification gate recursively discover nested `*.test.js` suites, so moving tests
into focused directories cannot silently remove them from the gate.

The browser keeps the original `File` for preview and unchanged download. It
also streams the same bytes to the host. The host stores them under an opaque
document ID in a private per-process temp root. GUI requests never carry a
filesystem path, executable name, engine flag, environment, or output path.
The CLI is a separate explicit local-filesystem authority: it snapshots only
caller-named inputs through a no-follow descriptor, copies them into the same
private store, and publishes only to caller-named outputs with no-clobber
same-directory linking.

## Request boundary

`scripts/host/router.mjs` composes the API with the existing allowlisted static
server. The API contract enforces:

- an exact local `Host` value;
- a random 256-bit token obtained from the same-origin bootstrap endpoint;
- the token on all data routes;
- a matching HTTP `Origin` for state-changing methods;
- explicit methods and non-simple media types;
- bounded raw-PDF and JSON request bodies; and
- opaque document/artifact identifiers.

Fetch Metadata rejects cross-site or opaque bootstrap probes when the browser
supplies those headers. Disconnecting a data request aborts its processing
signal; the GUI exposes cancellation for long derived-page, OCR, comparison,
conversion, and raster-mutation jobs.

There is no CORS policy, cookie, remote endpoint, arbitrary-path API, or
attachment-open route. The bootstrap response removes executable paths before
reporting availability to the browser.

## Storage and output semantics

`DocumentStore` streams an upload to `source.partial`, hashes it, validates a
PDF header, syncs it, and atomically promotes it to `source.pdf`. Session
directories use mode `0700`; stored files use mode `0600`. A source digest is
rechecked around transformations.

An operation writes only inside a private job directory. A PDF output becomes
downloadable only after it exists, stays under the size limit, has a PDF
header, can be parsed again by Poppler, and has the operation's expected page
count. It is then copied into its own artifact directory and receives a
recorded digest and provenance object. Page composition, conversion, rewrites,
OCR, and raster mutation therefore produce derived downloads; they never
masquerade as “Save” and never
overwrite the selected source.

`PdfKitProtectionService` is an optional local macOS derived-copy boundary, not
a general encryption service. It fixes Apple PDFKit output to AES-128/R4/V4/AESV2,
requires a printable-ASCII 12–16 character open password and a distinct
12–32 character owner password,
and provides only four measured, closed advisory permission profiles:
`deny-all`, `accessibility-only`, `print-only`, and `copy-accessibility`.
It accepts unencrypted, untagged, form-free, JavaScript-free,
unsigned PDFs with no attachments or URLs, capped at 100 pages and 128 MiB.
Credentials cross token-authenticated same-origin loopback HTTP as bounded
JSON, then enter the helper through bounded private stdin. They are not
intentionally retained in app state, files, results, provenance, argv, or
application logs; fields and mutable request buffers are cleared after use,
while browser developer tools, instrumentation, and runtime memory may retain
transient copies.
The source stays immutable. The separate output must pass encryption-dictionary,
unauthenticated-open, PDFKit reopen, Poppler parse/render, and digest-bound
promotion checks. Selectable AES/AES-256, arbitrary permission combinations,
recovery, and certificate encryption are outside this boundary.

The same service has a distinct current-session protection-removal profile. It
accepts only an exact retained artifact whose validated protection provenance,
permission profile, digest, and page count match one of the four fixed
AES-128/R4/V4/AESV2 envelopes. A fresh locked `PDFDocument` must unlock with
PDFKit `owner` status before any page is copied. Strict catalog, page, passive
annotation, action, signature, form, tag, attachment, URL, media, and automatic
presentation checks run before output. PDFKit then copies pages into a fresh
document and rebuilds only bounded direct/GoTo outlines; private pre/postflight
snapshots require boxes, rotations, ordered annotations, stable metadata,
outlines, text hashes, and render hashes to match. The host independently
requires a classic final trailer without `/Encrypt`, no-password Poppler reopen,
matching provenance-bound page count, passive structure, all-page renders, and
the promoted digest. The cleartext host artifact is consumed after its one
transfer, while the protected artifact and immutable source remain. This is
not recovery, cracking, bypass, arbitrary decryption, secure erasure,
legal-ownership proof, signature-safe rewriting, sanitization, redaction, or
byte/object preservation.

`PdfKitSanitizationService` is a separate fixed metadata-only boundary. The
`macos-pdfkit-metadata-sanitize-v1` profile accepts at most 100 pages/128 MiB
and only unsigned, unencrypted, untagged, form-free passive documents with a
strict catalog/page graph and no attachments, external URLs, or unsupported
name trees. It identifies document Info, custom Info, and catalog XMP, rebuilds
the accepted pages and bounded local outlines into a fresh `PDFDocument`, and
removes those three metadata categories. Because PDFKit injects Producer and
date entries when serializing, the native helper accepts only its exact
single-classic-xref output shape and blanks those three literal entries without
moving any xref offset. Reopen checks require an empty Info dictionary, no XMP,
and matching page boxes, rotations, ordered passive annotations, outlines,
per-page text hashes, and fixed render hashes. Independent Poppler postflight
requires absent standard/custom/XMP metadata, passive unsigned output, the
same page count, and a valid render for every page before digest-bound
promotion. The source remains immutable. This profile does not remove orphaned
objects, incremental revisions, unrelated hidden data, or prior bytes and does
not provide secure erasure, signature preservation, or byte preservation.

Native-produced workspace entries are recursively inventoried under a 512 MB,
1,024-file, 16-level ceiling. Symbolic links, multi-link files, devices, and
other non-regular entries fail the job. OCR PNG/TSV/ALTO/page-PDF products and
promoted artifacts are opened without following the final path, matched to the
validated inode, checked as single-link regular files, and read or copied from
that descriptor. Artifact promotion requires the caller's validated SHA-256,
checks that provenance names the owning document's current source digest,
rehashes bytes during the descriptor copy, honors cancellation before
publication, and rolls back on any mismatch. Size and timestamps are also
rechecked before the retained artifact is registered.

`PdfKitOutlineSplitService` composes one fixed macOS bookmark rule without
trusting browser inventory. It re-runs the digest-bound PDFKit inspection and
accepts only 2–100 titled top-level entries whose local physical-page targets
are complete, strictly increasing, and start at page 1. Titles and descendants
are ignored for composition and omitted from generic filenames and provenance.
Existing Poppler page extraction creates contiguous derived artifacts; a
512 MiB aggregate output limit applies, and every already-promoted artifact is
deleted if a later output, source recheck, or cancellation fails. This is not
nested/selected bookmark, blank-page, text, size, or page-label splitting and
does not claim arbitrary object, form, tag, layer, link, signature, or
conformance preservation.

`InputAssetStore` applies the same opaque-ID and private-mode model to supported
non-PDF inputs. Modern OOXML/OpenDocument archives pass a bounded ZIP parser
before deterministic text extraction when LibreOffice cannot produce a PDF.
Passive HTML is parsed as text and never executed. Legacy binary Office and DXF
formats have no fallback and fail with a typed prerequisite error.

OCR rejects extreme page boxes, renders each page inside a 3,200-pixel square,
validates the intermediate PNG before Tesseract, optionally applies fixed
ImageMagick cleanup, optionally writes at most 256 normalized user words to a
mode-`0600` job-private file created with exclusive ownership, records
low-confidence TSV words, and composes the page PDFs. Tesseract receives only
the host-resolved `--user-words` path. Results and provenance retain the exact
canonical word-file digest and term count, never the words or path. Workspace
teardown removes the file. The final file must preserve the source page count; when words were
recognized, Poppler must extract text from its text layer. Page/region layout
analysis emits strict normalized TSV geometry, bounded ALTO XML, positioned
review HTML, heuristic TSV-geometry table grids, and CSV whose formula-leading
cells are sanitized for spreadsheet import. Table grids require human review
and are not authoritative recognition. This creates searchable raster output
and review evidence, not editable or
structure-preserving OCR.

Before the GUI publishes a searchable OCR download, it requires the response's
document ID and source digest to match the current operation, requires the Blob
size to match the artifact record, and recomputes its SHA-256 with Web Crypto.
Because that browser API materializes a contiguous buffer, this path accepts at
most 64 MiB and deletes a larger ephemeral artifact without retrieving it.

The browser may classify at most 500 low-confidence words from the current
validated OCR document result. `local-ocr-suspect-review-export-v1` snapshots
the inventory and three-state decisions, derives a canonical digest for every
suspect, and emits at most 4 MiB of recursively key-sorted JSON bound to the
source digest, OCR artifact ID/digest, and OCR parameters. The report is
session-only review evidence: it applies no corrections, changes no PDF or OCR
artifact bytes, and makes no source-page alignment or authoritative-text claim.

## Engine boundary

The engine registry searches only `/opt/homebrew/bin`, `/usr/local/bin`,
`/usr/bin`, and `/bin`, checks executability, resolves an absolute path, and
parses a version probe. In-flight probes are deduplicated. The process runner
uses `spawn` with `shell: false`, validated string arguments, a minimal
`LANG`/`LC_ALL` environment, bounded stdout/stderr, a deadline, and abort
handling. One shared limiter allows four native children and 24 queued jobs.
It keeps a slot occupied until a killed process emits `close`; if that does not
happen within the reap grace period, the slot is quarantined instead of being
reused. If all slots become quarantined, queued and new jobs fail with a
restart-required host error. Raster builders use Poppler's `-scale-to` pixel
box after a bounded page-geometry inspection. Job directories have a monitored
recursive 512 MB cumulative quota. OCR rasters and review files, and page-composition parts,
are deleted after their last validation/consumer. Adapter builders own every
engine flag and output pattern. Raster mutation always discloses that it destroys vectors,
forms, links, tags, layers, and signatures. Its `verified-raster-burn-v2`
redaction subset binds declared source text only transiently to an unrotated
target region or entire selected page whose CropBox matches its MediaBox,
verifies target pixels are opaque black and all non-target
pixels are unchanged, and rejects output unless it is passive, unsigned,
textless, attachment-free, and object-URL-free. It is a destructive image-only
subset, not object-level sanitization.

The source-bound redaction-plan bridge is a separate pair of authenticated
host routes, not a generic `redaction.apply` surface. Plan creation inspects
the staged immutable source locally for page geometry and normalized text in a
reviewed full-page or normalized CropBox target. The stored internal sidecar
record binds the source digest, page, geometry digest, and text through a
per-process HMAC; it retains only the HMAC digest and text length, never
plaintext text, excerpts, or the key. The browser-facing plan strips even that
private binding metadata. Applying accepts only source/workspace digests and
revision plus plan/mark IDs and plan digest. A workspace read lease prevents
concurrent sidecar changes; strict current-plan validation rejects legacy,
stale, altered, or mismatched plans before re-extracting and checking the
private source evidence. The transient evidence feeds only the existing
`verified-raster-burn-v2` raster validator, which promotes a separate derived
artifact. The source is immutable and the plan remains `proposed-not-applied`.
`RedactionPlanReportService` exposes a third authenticated, non-mutating route
for one selected strict proposal. It holds the same exact workspace read lease,
rechecks the immutable source before and after plan selection, recomputes the
plan digest, and returns a canonical JSON-only public projection capped at
64 KiB. The projection carries source/workspace/plan/profile bindings and
public normalized geometry, but strips text bindings, page-geometry digests,
paths, artifacts, and application claims. Its status remains
`proposed-not-applied` and `pdfBytesChanged` is always false.
Rotated pages, unequal CropBox/MediaBox geometry, object-level removal,
hidden-data or prior-revision cleanup, signature preservation, and any broader
professional redaction claim remain outside this bridge.

Comparison verifies both immutable source digests around each job. Exact word
diffs, rendered-pixel difference masks, annotation-sidecar diffs, batch limits,
and JSON/CSV reports are bounded. Overlay and side-by-side comparison modes are
explicit descriptors only and never claim rendered composite output.

`ProjectBundleService` canonically serializes the complete bounded workspace
without its session document identifier, hashes the payload, and binds it to
the immutable source PDF SHA-256. The authenticated API imports raw canonical
UTF-8 only with an explicit expected revision, verifies the payload and source
digests, then rebinds and atomically replaces state through
`WorkspaceStateStore`. This is manual local portability, not a PDF portfolio,
embedded markup, DMS, or synchronization protocol.

Prepress copies the immutable source into a private job before Ghostscript sees
it, monitors the whole job workspace, validates separation TIFF dimensions,
and returns structurally validated bounded PNG previews. Ink coverage,
separations, and simulated overprint are review evidence only. Fixed
print/archive review profiles combine bounded Poppler font, image, page-box,
metadata, encryption, and JavaScript evidence into deterministic JSON.

The artifact path discovers Ghostscript's exact installed default CMYK printer
profile through the pinned executable, copies it privately, validates its ICC
header/tag table, and binds its digest into a fixed CMYK-targeted recipe. A
separate fixed 2-up/4-up row-major N-up recipe accepts only identical,
zero-origin, unrotated MediaBox/CropBox geometry and always rejects printer
marks. Both paths require Ghostscript exit zero, exact workspace inventory,
source/profile identity, expected page count/geometry, passive output,
normalized extracted-text equivalence, successful rendering of every page, and
digest-bound promotion; a parseable leftover after engine failure is never
published. Production validation combines the fixed print review and average
process-ink coverage in a source-bound receipt. Checks distinguish pass,
warning, fail, and not-checked. None of these paths assigns or validates an
OutputIntent, colorimetrically retargets existing DeviceCMYK, removes
Separation/DeviceN, proves vector preservation, supplies production marks, or
claims PDF/A, PDF/X, PDF/UA, GWG, Ghent, Certified PDF, press, or RIP
certification.

The authenticated document route exposes one fixed accessibility profile,
`basic-local-review`, bound to the immutable source PDF digest and capped at
200 pages and 50,000 structure records. It normalizes Poppler tag roles and
bounded parent relationships, title/language metadata, font embedding and
ToUnicode indicators, image inventory, and empty-text pages into deterministic
JSON carrying its own SHA-256 and fixed evidence references. Unknown roles or
malformed indentation make hierarchy coverage unknown instead of passing.
Optional pinned PDFKit evidence can check the document assistive-access
permission on macOS; integrity and parser failures fail closed. Link purpose,
reading order, alternative text, form semantics, artifacts, contrast, and
PDF/UA conformance remain unproven.

A separate accessibility-remediation service recomputes that trusted report,
binds proposed operations to its current candidates and the workspace revision,
and atomically stores one canonical sidecar entity. Export requires the
server-generated proposal ID. Every operation is `proposed-not-applied`, needs
human review and an approved tagged-PDF writer, and makes no conformance claim;
the service never writes PDF bytes. The image-alt-text subset accepts authored
text only for one exact current `author-image-alt-text` locator. It trims and
NFC-normalizes 1–1000 UTF-16 units, rejects control/format characters and
unpaired surrogates, and rejects missing, unknown, or duplicate targets. It
also rejects leading path-like text to match the generic local-sidecar leak
policy. It does not receive image bytes, infer a description, apply tags, or
validate the description's meaning.

Standards validation is deliberately separate from heuristic preflight and
accessibility review. The optional loader accepts only a read-only
`verapdf-bundle-v1` inventory pinned to veraPDF 1.30.1, verifies every listed
regular file, and rejects links, writable components, missing files, and
unexpected files. It then probes the exact version and complete fixed profile
list in private home, cache, and temporary directories. Validation copies and
rehashes the immutable source, invokes one fixed PDF/A or PDF/UA flavour,
accepts exit status 1 only as completed nonconformance, and reduces the bounded
one-job JSON report to counts and source/bundle/version evidence. Raw paths,
statements, rules, contexts, and messages never cross the API. No trusted
bundle or native conformance fixture is present in the repository, so
bootstrap reports the feature unavailable. PDF/X, custom profiles, WTPDF,
directories, archives, passwords, and automatic profile selection fail closed.

The optional macOS PDFKit routes accept only the exact `macos-read-only-v1`
inspection profile, `macos-pdfkit-derived-v1` category profile, or
`macos-pdfkit-targeted-v1`, `macos-pdfkit-local-goto-v1`,
`macos-pdfkit-local-goto-remove-v1`, `macos-pdfkit-outline-v1`,
`macos-pdfkit-outline-remove-v1`, `macos-pdfkit-outline-rename-v1`, or
`macos-pdfkit-line-annotation-v1` or `macos-pdfkit-ink-annotation-v1`
source-bound profile and no query
parameters, paths, limits, environment, or executable override. Mutation
requests are capped at 8 KiB, include the current lowercase source SHA-256, and
contain exactly one typed category: four standard metadata fields, one page
box, one selected-page absolute rotation of 0/90/180/270 degrees, or one non-
action-bearing `text` sticky-note, `freeText`, `square`, `circle`, or
`highlight` annotation. Every source-side inspection, signature check, and
helper invocation uses the same descriptor-copied, digest-bound, single-link
mode-`0400` private input. Selected-page CropBox, BleedBox, and rotation reject
signed and no-op sources. CropBox and BleedBox additionally reject rectangles
outside the page MediaBox; BleedBox must contain the unchanged TrimBox, while
CropBox expansion can reveal previously cropped source content. PDFKit
candidate/reopen checks prove the requested page box or rotation and preserve
every unrelated page box and rotation. Rotation compares annotation count and
subtype order. Crop and Bleed additionally compare a private bounded ordered
descriptor of public/raw subtype, bounds, flags, contents digest, and bounded action,
destination, Popup/Parent, and appearance shape; appearance streams are hashed
after bounded decoding. Poppler independently confirms the requested output
state and renders every page; BleedBox also requires byte-identical fixed
256-pixel-long-edge source/output validation renders on every page. That
bounded check does not prove equality at other resolutions or in other
renderers. The proof covers resolved geometry, not explicit-versus-inherited
box syntax.
Every bounded annotation and widget inventory record carries its original
zero-based `page.annotations` index plus a domain-separated SHA-256 fingerprint
bound to the exact descriptor-read source bytes, page, subtype, and widget
type. The locator exposes neither annotation contents nor widget values and
changes when the source bytes change.
Button widgets additionally expose only a bounded `checkbox`, `radio`, `push`,
or `unknown` control kind. Current state, export/on-state name, appearance data,
and group semantics remain private. The targeted profile may set one unique,
named, raw-unflagged checkbox on or off only when its private raw dictionary has
exactly `Off` plus one valid custom on-state appearance and its current `/AS`,
`/V`, and public PDFKit state agree. The target must be a direct terminal root
widget with its own `/FT`, non-empty `/T`, and no `/Parent` or `/Kids`, so
inherited field flags cannot be silently normalized. On input, the same raw
page-widget object must occur exactly once as a direct AcroForm `/Fields`
entry; orphaned, duplicated, parent-owned, and ambiguous membership fails
closed. Radio selection has a separate canonical topology: exactly one direct
parent field owns 2–50 unique reciprocal page-widget kids, each with exactly
`Off` plus one unique private on-state appearance. Parent `/V`, every child
`/AS`, page membership, flags, and public PDFKit state must agree before the
mutation. The request identifies only the exact source-bound target widget and
the fixed `select` intent; private state names and the current selection never
leave the helper. Push controls remain inventory only. The targeted profile
uses that locator to fill one supported text/choice
AcroForm widget, clear one non-required single-selection choice whose current
private value belongs to its bounded unambiguous options, apply that bounded
checkbox transition, select one option in a canonical radio group, or
update/remove one inert annotation. The helper recomputes
the locator from descriptor-read bytes, rejects no-ops and unsafe widget or
annotation properties, writes a separate output, and verifies the private
value/contents after reopen without emitting them. For removal, a private
bounded snapshot contains each page's ordered reachable annotation descriptors
covering public/raw subtype, rectangle and flags, a contents digest, and a
sensitive action/destination/relationship/appearance-shape digest. Reopen must
equal that snapshot with exactly the selected page/index descriptor occurrence
omitted, and raw annotation identity must be unique across all page arrays; no
descriptor leaves the helper. This does not prove that unreachable bytes or prior revisions
were scrubbed. Targeted
operations reject signed, encrypted/locked,
JavaScript/XFA/calculation-bearing, stale-locator, action-bearing,
signature-field, read-only, password, shared, malformed, and unsupported
inputs. Choice-clear postflight requires an empty reopened private value and a
changed target-page raster. Checkbox postflight also requires reopened raw
`/AS` and `/V`, public
button state, the private custom on-state name, and a changed thumbnail raster
to agree without emitting any of them. Both preflight and reopened postflight
run the same bounded raw safety scan: catalog `/Perms`, catalog/page/annotation/
outline actions, non-`Dests` name trees, AcroForm `XFA`/`AA`/`CO`, action or
signature fields, and malformed/cyclic over-limit trees fail closed.
Radio postflight additionally requires the parent `/V` to match the target's
private on-state, the target `/AS` to match it, every sibling `/AS` to be
`Off`, exactly one public selection, unchanged flags/topology/appearance-state
sets, and changed renders for the target page and any different page that held
the prior selection.
PDFKit can serialize the reopened page annotation and direct field record as
different indirect objects. Postflight therefore requires exactly one direct
field record to semantically match the reopened page widget on `/FT`, `/T`,
`/Ff`, `/V`, `/AS`, and `/AP` presence instead of claiming indirect-object
identity or preservation.
Legacy category rewrites still require `Form: none`; form filling requires
exact `Form: AcroForm`; multi-operation batches fail closed.

The isolated local-GoTo profile accepts only source page, existing target page,
and a CropBox-contained rectangle. The target point is deterministically the
target CropBox top-left; callers cannot provide a URI, action, filename, named
destination, script, label, or target coordinate. Input must be unsigned,
unencrypted, form-free, and JavaScript-free. Catalog/page/outline action entry
points and non-destination name trees are rejected. Each pre-existing
annotation must have an explicitly allowed inert subtype and no action,
associated-file, file-specification, multimedia, 3D, RichMedia, or external-
data payload keys. FileAttachment, Sound, Movie, Screen, RichMedia, 3D,
Projection, automatic presentation, and page-associated-file surfaces are
rejected. PDFKit emits
both `/Dest` and a redundant `/A << /S /GoTo /D ... >>`. Delta-aware reopened
raw validation permits that one new action only when the action dictionary has
exactly `/S` and `/D`, both destination arrays resolve to the requested page
and deterministic point, public PDFKit reports the same local destination,
and every other page's annotation count is unchanged. The compact receipt is
source/output-digest bound and omits the rectangle and any link target string.

The isolated `macos-pdfkit-local-goto-remove-v1` profile accepts exactly one
page, annotation index, and opaque fingerprint from the fully inspected source.
Native admission recomputes the fingerprint and requires the selected
annotation to have identical direct `/Dest` and redundant `/A /GoTo /D`
arrays. It rejects other action forms and ambiguous raw annotation identity.
Before mutation it snapshots every page box, rotation, and ordered passive
annotation descriptor. Candidate and private-file reopen must equal that
snapshot with only the selected descriptor occurrence removed. The compact
source/output-digest-bound receipt exposes the page and index but not the
fingerprint or destination. This proves one reachable annotation delta; it
does not scrub unreachable objects, orphan bytes, incremental history, or
prior revisions and does not preserve byte or indirect-object identity.

The isolated outline profile accepts one existing page and one NFC label of
1–1,024 UTF-8 bytes with no edge whitespace, control, format, line-separator,
or paragraph-separator characters. It appends exactly one top-level direct
destination at the target page's CropBox top-left; callers cannot provide an
action, coordinate, nesting position, named or remote destination, script,
replacement, or removal request. Candidate and private-file reopen checks prove
the exact raw `/Dest`, public destination, appended suffix, unchanged prior
outline hierarchy/order/labels/destinations/open state, every page box and
rotation, and the ordered passive annotation inventory. Existing GoTo-action
outlines fail closed because measured PDFKit serialization normalizes their
representation to direct destinations. The compact source/output-digest-bound
receipt retains the target page and label SHA-256, not the private label.

The paired outline removal and rename profiles consume an opaque source-bound
top-level-index/fingerprint locator emitted only for a fully inspected leaf
with a raw direct `/Dest [page /XYZ x y null]`. Removal deletes exactly that
node. Rename accepts one changed trimmed NFC label and changes only the decoded
title while retaining the target's destination and position. Both paths compare
the expected outline-tree delta plus every page box, rotation, ordered passive
annotation descriptor, per-page extracted-text hash, fixed render hash, and
bounded standard Info field at candidate and private-file reopen. Compact
receipts omit titles, locator, destination, and coordinates; rename retains
only the new-label SHA-256. Nested/non-leaf targets, action destinations,
page labels, tags, layers, XMP, custom Info, unsafe name trees, and non-passive
page dictionaries fail closed.

The isolated line-annotation profile accepts one page, private bounded
contents, and two distinct CropBox-contained points. It computes a padded
positive annotation rectangle internally, creates one `/Line`, and fixes both
ending styles to `None`; callers cannot provide bounds, styles, colors,
actions, files, or appearance data. Candidate and private-file reopen checks
prove the exact page-coordinate endpoints through public PDFKit and raw `/L`,
raw `/LE [ /None /None ]`, the one-annotation suffix delta, page count, inert
content graph, and source/output digests. Its compact receipt omits contents,
coordinates, and bounds.

The isolated ink-annotation profile accepts one page, private bounded
contents, and exactly 2–32 CropBox-contained points with no consecutive
duplicates. It derives a positive padded rectangle, creates one `/Ink`
annotation with exactly one open path, and exposes no style, color, opacity,
author, popup, action, file, or appearance controls. Candidate and private-file
reopen checks prove the exact page-coordinate path through public PDFKit and
raw `/InkList`, the one-annotation suffix delta, page count, inert content
graph, and source/output digests. Its compact receipt omits contents, points,
and bounds. For all four authoring profiles, raw `/Popup` and `/Parent`
references are admitted only as reciprocal inert pairs whose objects both
occur directly in the same page `/Annots` array. Hidden, orphaned, cyclic, or
active related nodes reject the input, candidate, or reopened file.

`local-square-annotation-flatten-v1` is a separate platform-independent closed
rewrite path. The browser selects the sole square annotation from the pinned
PDFKit inventory, but the host independently recomputes the locator from the
immutable source SHA-256, one-based page, zero-based annotation index, subtype,
and non-widget marker. Raw admission requires one indirect `/Annot /Square`
with `/F 4`, a direct rectangle, and exactly one normal appearance reference.
That appearance must be an uncompressed Form XObject with an identity matrix,
positive BBox, empty direct resources, direct length, at most 4 KiB of
unfiltered bounded vector-only operators, and no group, metadata, filter, or
optional-content surface. The unrotated page has direct resources and no
existing XObjects. One deletion transaction removes `/Annots`, appends a tiny
`q cm /PWF0 Do Q` stream using the exact BBox-to-Rect transform, and binds the
unchanged appearance as the page XObject. A compact rewrite then removes the
annotation and every prior revision. Independent canonical reconstruction and
raw output inspection require one closed classic revision, an unresolvable
target reference, no reachable annotations, exact appearance bytes and page
binding, unchanged Root and Info references, and the fixed ID policy. Poppler
page/text/box and 256-pixel render equality plus unsigned-output and immutable
file checks remain separate gates. This engine does not expose a general
object, content-stream, appearance-resource, or annotation-flatten API.

The native executable is decomposed by trust responsibility rather than kept
in one entrypoint file. Protocol and inventory models, strict request
validation, workspace I/O, inspection, response encoding, raw-document safety,
standard mutation, protection, targeted mutation, canonical radio mutation,
AEC mutation, local navigation/annotation mutation, and outline bookmark
mutation each have a dedicated Swift source file.
`main.swift` contains only bounded operation dispatch and error mapping. These
files share module-internal helpers only inside the executable target; the
package exposes no new public API.

The host considers it ready only after a fixed packaged or SwiftPM release
candidate passes leaf/ancestor containment, ownership, mode, Mach-O, link-count,
inode, size, and digest checks. It copies the opened bytes into the private
session as a mode-`0500` executable and re-hashes that staged copy before every
job. No debug/PATH fallback or runtime Swift compilation exists.

The helper reads the mode-`0400` input through `O_NOFOLLOW`, matches `lstat` and
`fstat`, caps it at 128 MiB, retains descriptor-read bytes for `PDFDocument`,
and emits at most 512 KiB of strict JSON. For mutation, it writes only a new
mode-`0600` `output.pdf` with `O_EXCL|O_NOFOLLOW`, reopens the output,
checks page count and the requested final-state effect, and never overwrites the
input. The host rechecks private input/request identities and digests, exact
workspace contents, original source digest, stable output digest, Poppler page
count, and a 256-pixel render of every page before digest-bound promotion.
Local GoTo outline destinations that PDFKit resolves to pages become bounded
GUI navigation entries. The helper retains at most 200 outline entries through
eight levels; only structurally correlated raw direct destinations or restricted
GoTo actions can navigate. Mixed, malformed, unsupported, or unresolved action
dictionary entries stay inert. Bookmark mutation is limited to separate
append-one, exact top-level-leaf removal, and exact top-level-leaf title-rename
direct-`/XYZ` destination profiles. Opaque locators are emitted only for a
complete non-truncated tree and are rederived before one node is removed or
renamed; native candidate and reopen checks preserve the expected tree delta,
page geometry, ordered passive annotations, extracted text, and fixed renders.
The removal and rename profiles admit only a strict passive catalog/page
shape with bounded standard Info metadata; tags, layers, page labels, XMP,
custom Info, name trees, and viewer preferences fail closed. The same source-bound
inventory validates PDFKit-resolved logical labels against their physical page
records for at most 100 pages and displays the first 20 as local navigation;
each retained label is exact through 1,024 UTF-8 bytes and longer labels fail
the inventory. It does not search, disambiguate, number, or author labels. It also exposes local
GoTo link destinations, inert URL/remote/named link
records, and bounded `/OCProperties/OCGs` group names. Poppler named-
destination records are rendered as local page navigation. No action is
executed. The local-GoTo and outline-bookmark authoring profiles create
separately validated derived copies but never follow their new navigation
targets during processing. Optional
content is not toggled, rendered separately, or edited;
unsupported actions remain unresolved records. Evidence
names describe requested postconditions and successful reparsing, not
filesystem/network containment, byte/object preservation, incremental update,
signature survival, or standards conformance. Developer release builds are
session-pinned local evidence. Signed/notarized packaged binaries and a stronger
OS sandbox remain distribution gates.

The helper supplements public PDFKit with bounded read-only Core Graphics
dictionary traversal for the catalog, page and annotation dictionaries,
outlines, name-tree root, and AcroForm field graph. The targeted form and inert-
annotation scan rejects
catalog `OpenAction`/`AA`/`Perms`, page and annotation actions, outline actions,
name-tree roots other than `Dests`, AcroForm `XFA`/`AA`/`CO`, action/signature
fields, and malformed, cyclic, or over-limit graphs before mutation and after
reopen. The local-GoTo profile uses its separate delta-aware scan, whose only
postflight exemption is the exact newly appended local action described above;
the inert annotation allowlist and active payload-key checks run before
serialization, on the candidate bytes, and again after private-file reopen.
Neither scan is a complete PDF semantic validator or a general
safe object editor; unsupported dictionaries and structures remain outside the
executable subset.

The dependency-free CLI exposes only named operations and fixed option enums.
It accepts no engine path, arbitrary flags, environment override, temp root,
concurrency control, recursion, glob, force, or overwrite option. Batch OCR is
sequential and capped at eight files, 50 pages, and 512 MB aggregate
input/output. Watch OCR uses two stable snapshots, rejects PDF symlinks, never
deletes an input, processes sequentially, and stops at the session file/byte/page
ceilings. Durable manifests state partial failure instead of implying a
transactional batch.

The source-free `create-blank` lane accepts only a 1–500 page count and a
caller-named output. It fixes every page at 612 × 792 points and the title at
`Untitled`, then stages one descriptor-bound immutable snapshot. Poppler checks
that same snapshot for page evidence, `Encrypted: no`, `JavaScript: no`,
`Form: none`, and empty extracted text; the CLI publishes those exact
SHA-256-verified bytes. Those three Poppler indicators are not a complete
active-content scan. Atomic no-clobber publication is the commit point, so a
later cancellation or receipt-stream failure does not delete an already
committed output. This lane does not promote the broader professional creation
claim.

The `convert-local` lane accepts one descriptor-read, single-link PNG of at
most 16 MiB. A strict in-process decoder verifies chunk CRCs, bounded inflate,
8-bit RGB/RGBA samples, a maximum 8,192-pixel edge and 8,294,400-pixel raster,
and rejects animation, interlacing, transparency keys, and unsupported critical
chunks. Only a metadata-free RGBA re-encoding reaches ImageMagick, through
bounded stdin and fixed memory, map, disk, area, dimension, thread, and time
limits. The resulting PDF is descriptor-read once; `pdfinfo`, `pdftotext`, and
`pdfimages` consume those same bytes over bounded stdin. Publication requires
one page, bounded page geometry, Poppler's exact `Encrypted: no`,
`JavaScript: no`, and `Form: none` indicators, empty extracted text, and one
primary image matching the decoded PNG dimensions. The receipt distinguishes
the selected PNG digest, normalized-raster digest, and published PDF digest.
This profile neither preserves PNG metadata/color profiles nor proves exact
pixel/color fidelity, and it does not promote general or multi-image
conversion.

This does not provide a complete native sandbox. A hostile document can reach
the enabled trusted local parsers, and pure Node cannot provide hard portable
CPU, memory, descendant-process, or network denial. Ghostscript, LibreOffice,
and ImageMagick are enabled only through fixed allowlisted adapters. Key-bearing
signing and arbitrary executables remain disabled.

## Catalog and claims

`catalog/capabilities.json` marks a professional function `implemented` only
when an engine or shell behavior and an evidence file exist. Strict schemas require evidence
for implemented records and `null` evidence for planned records. The generated
feature-gap report is checked byte-for-byte in tests.
`catalog/prototype-coverage.json` separately closes over all 318 IDs with an
exact-alpha, executable-subset, sidecar, service-only, descriptor, proposal,
blocked, or AI-excluded tier. A useful subset never silently promotes the
broader professional claim.

The browser-native viewer remains an external platform boundary. Preview zoom
and rotation are visual state, not written page properties. Link and
active-content behavior inside that viewer is browser-controlled. The separate
controlled-raster session requests one selected page from a dedicated
authenticated CropBox route. The route accepts only the opaque document ID,
page, and integer 36–240 DPI mapped to a capped longest edge; it validates the
page through immutable source inspection, invokes fixed `pdftocairo -cropbox`
arguments against one descriptor-copied, digest-bound, single-link private
mode-`0400` source in the job workspace, rechecks that copy's identity and
digest plus the store source, validates the bounded PNG, and cleans up.
It aborts superseded requests, rejects oversized, non-PNG, or undecodable
responses, revokes the prior Blob URL on navigation, mode exit, document
replacement, close, and unload, and renders no PDF action surface. This passive
local CropBox image has no selectable text and is not object preservation,
layer rendering, or a vector-, tag-, form-, or structure-preserving renderer.
Separately, the page-text clipboard controller reads only the already bounded
Poppler extraction for the selected physical page. It rejects empty or
over-20,000-UTF-16-unit text and unavailable `writeText`, snapshots document
operation and page-generation authority, and announces success only after the
write resolves while that authority is still current. Browser clipboard writes
cannot be rolled back if the page changes during the pending call. This is not
selection inside the native PDF viewer and changes no PDF or host state.
The separate snapshot endpoint reuses that immutable-source CropBox render and
accepts only page, integer 36–240 DPI, and an exact six-field query containing
one six-decimal normalized top-left rectangle. The bounded PNG codec verifies
signature, dimensions, chunk order, CRCs, compressed/inflated limits, filters,
and terminal structure before cropping left/top with `floor` and right/bottom
with `ceil`. The GUI decodes the result before explicit Clipboard API copy or
download. Clipboard copy is gated on browser PNG support and permission. The
output is a standalone PNG with no PDF text, vectors, links, tags, layers,
forms, or object structure; no PDF bytes are changed.
The loupe is a second `ControlledRasterSession` over the snapshot endpoint. It
uses the current normalized region at fixed 240 DPI, displays the retained Blob
URL in the inspector without replacing the browser-native full-page surface,
and aborts/revokes on refresh, region commit, page selection, view change,
document replacement/close, or unload. Decode-before-retain and stale-
generation checks are identical to the controlled raster session. It is raster
magnification only and exposes no additional PDF semantics.
Offline signature inspection gives `pdfsig` a fresh host-owned NSS directory
and fixed `-nocert`/`-no-ocsp` arguments, then independently exposes only a
strict no-raw/no-path integrity and full-versus-prior-revision coverage result.
Only when Poppler reports valid integrity, a second fixed pass streams the CMS
through an exact pre-created FIFO inventory in a mode-`0500` private directory.
Nonblocking host readers retain at most 1 MiB per signature and 8 MiB total and
abort the child on the first excess byte; FIFO backpressure prevents unbounded
or regular-file output. Only a successful bounded receipt is promoted to mode-
`0600` regular files before descriptor, identity, mode, size, and digest
postflight. A no-follow descriptor check of each ByteRange-excluded direct PDF
string remains defense in depth and is not the authoritative output ceiling. These
checks bind each bounded dump to Poppler's byte ranges and subfilter. On macOS, a separately staged,
digest-pinned Foundation/Security/CryptoKit helper accepts bounded DER or BER,
verifies the exact detached CMS against those byte ranges, and only then
evaluates its certificate path. It creates `SecPolicyCreateBasicX509` and
evaluates every record at one captured host-current time against the current
Mac trust configuration, while both disabling and verifying disabled
certificate fetching. Unsupported subfilters, malformed CMS/BER, signature
mismatches, and bounded-resource conditions fail closed as unsupported or indeterminate.
The evidence model preserves Poppler integrity and coverage as explicitly
engine-scoped fields. The combined conclusion is indeterminate when exact
mapping or any supported CMS prerequisite is unavailable or indeterminate; the
UI prioritizes negative records and reports how many bounded records it omits.
This is not offline/no-Keychain validation and does not establish signer
identity, PDF-signing key usage, validity at signing time, trust elsewhere,
revocation, OCSP, CRL, LTV, trusted timestamps, DocMDP/certification
permissions, legal effect, or signing. Native CMS and certificate parsing is
unsandboxed; parser compromise remains a residual risk.

## Plugin boundary

The seven `plugin.template.json` files can reference catalog capabilities, but
they have fixed `planned` status, no entrypoint, and no executable manifest.
The host now verifies canonical Ed25519-signed package bytes, scoped publisher
trust, immutable content-addressed installs, pinned dependency DAGs, activation
rehashing, controlled rollback, explicit grants, opaque document handles, and
bounded length-prefixed RPC. Package metadata and signed files are reread through
no-follow, single-link descriptors with bounded fatal-UTF-8 decoding and pre/post
identity checks. Opaque document-range reads likewise use a no-follow descriptor,
require a private single-link regular file owned by the host user, bind path and
descriptor identity, and verify the recorded size and full source SHA-256 before
and after every bounded range. A host-only launch descriptor rehashes the active signed
inventory after dependency resolution. The streaming transport incrementally
parses one frame at a time, enforces input/output cumulative quotas, dispatches
only the broker-bound number of concurrent requests, serializes backpressured
writes, and closes the activation on EOF, truncation, cancellation, or broker
failure. It has no pending request queue: saturation fails closed. One separately
bounded control lane lets an in-band cancel frame overtake active requests. A
one-shot operation session binds package
hash, activation, operation, nonce, grant, and opaque document handle and
revokes both authorities on every close path. Runtime dependency graphs are
rejected for this first execution contract. A separate canonical 64 KiB
worker-control codec defines exact invoke, completion, sanitized failure, and
cancellation envelopes. Invocations name one capability and carry only an
opaque document handle plus bounded JSON; paths, document IDs, environment,
executables, and arbitrary arguments are forbidden.

Manifest v3 adds one exact executable profile:
`javascriptcore-classic-script` API v1 with a signature-bound `.js` entry and
no dependency graph or ESM syntax. Manifest v2 packages remain verifiable and
installable but cannot produce an executable launch. The package store rereads
and rehashes the active entry after every asynchronous check, then returns its
bytes separately from the path-bearing descriptor. A runtime authority registry
serializes activation changes per plugin, terminates every matching old
operation before commit, retains failed termination handles in quarantine, and
retries them before a later transition can commit.

The concrete macOS adapter stages only
`Contents/Helpers/PDFPluginSupervisor` and adjacent `PDFPluginWorker`; it has no
SwiftPM/debug candidate. A signed host policy pins both whole-file SHA-256
digests, Team ID, current-architecture CDHashes, and the digest of exact
team-and-identifier requirements. Before source delivery, `/usr/bin/codesign`
performs strict all-architecture static validation, exact App Sandbox
entitlement validation, and a live supervisor-PID check. The supervisor then
spawns the adjacent worker without source authority, checks inherited RPC pipes,
hard quotas, static/current supervisor identity, and static/live worker
identity. The host validates the canonical ready frame against its independent
policy and live-checks the worker PID before sending the operation envelope.
Only inherited descriptors carry source, control, result, and brokered RPC
frames; no named listener, source path, document path, environment authority,
or plugin-selected argument crosses the boundary. Stdout accepts exactly ready
plus completion/failure frames, stderr is byte-capped, RPC starts before phase
two, and a dedicated process group receives bounded TERM/KILL/reap cleanup.

Host-side `AbortSignal` cancellation closes authority before fallible stream
teardown, including while output is finalizing. An asynchronous request failure
can still be observed after up to the configured request-lane count has already
started; the ceiling bounds that race, and no later work is queued.
Task draining relies on the host-owned `PluginRpcSession`, whose close path
aborts every active request; arbitrary look-alike session implementations are
not a supported production transport authority.

The macOS experimental probe runs the fixed system `sandbox-exec` with
network, filesystem-write, sensitive-root-read, process-fork, and dynamic-code
denials plus `--jitless`; current integration evidence observes `EPERM` for all
four attempted capabilities. A separate fixed Node `--permission` canary also
observes denied filesystem read/write, child-process, worker-thread, and
network APIs. Node permissions are defense in depth, not a malicious-code
sandbox. A fixed inherited `RLIMIT_CPU` canary terminates a spin loop after one
CPU second; this is an observation, not aggregate descendant accounting or
production quota evidence. The Seatbelt profile deliberately begins with `allow
default` so system Node can start and is not a production filesystem allowlist.
It always reports `osSandbox: false`, no production CPU ceiling, and no hard
memory ceiling. The production gate now requires separate CPU, hard-memory, process,
and output evidence; RSS watchdogs and V8 heap limits are classified only as
best effort.

An authenticated same-origin `POST /api/plugin-sandbox-probe` exposes only a
strict, sanitized snapshot of that diagnostic evidence. The body must be exactly
`{}`; concurrent calls share one in-flight promise and the result, including an
unavailable result, is cached until host restart. The response contains fixed
booleans/enums and a timestamp only - never profile text, paths, arguments, raw
output, exceptions, package bytes, or browser-supplied execution evidence. The
browser validates the exact response contract and presents diagnostic canaries
separately from hard controls. All five hard controls and `executionReady`
remain false, even if every canary passes, and no plugin code is executed.

Those are fail-closed foundation contracts, not an enabled runtime. The normal
path rejects unsigned SwiftPM artifacts, and no signed/notarized release pair or
signed release-policy resource is shipped. More importantly, a meaningful
`RLIMIT_AS` setting returns `EINVAL` on the current macOS host; the worker
attests `hardMemoryQuota: false`, the adapter terminates it before operation
authority is created, and `platform.plugins.runtime-sandbox` stays blocked.
Node path opens also cannot atomically pin ancestor directories. Production
enablement requires a Developer-ID-signed, hardened-runtime, App-Sandbox,
notarized pair, a supported hard-memory control, and adversarial packaged
end-to-end evidence. Notarization/Gatekeeper is a distribution gate and is not
inferred from the ready frame.

See [SECURITY.md](../SECURITY.md), [capability coverage](capability-coverage.md),
and the [capability coverage](capability-coverage.md) map.
