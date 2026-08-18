# Local-only implementation plan

## Product boundary

This roadmap implements professional PDF functions entirely on the user's
machine. It excludes AI and does not require document upload, cloud storage,
hosted conversion, telemetry, remote DMS, remote e-signature, or networked
collaboration.

The AI skeleton remains only so the research catalog records what commercial
tools offer. Every `ai.*` capability stays `planned` and is excluded from this
roadmap.

The generated current-versus-missing report is not retained in this archive. Its
versioned source snapshot remains in
[`catalog/research-scope.json`](../../../catalog/research-scope.json).

Local release closure is a separate, narrower gate. It inventories every
JavaScript and native Swift source file, proves the browser, host, and CLI production graph from
real entrypoints, and requires disconnected executable-plugin foundations to
remain explicitly classified as unshipped. Its receipt reports local inventory
status separately from a permanently `not-ready` distribution status until
signing, notarization, and SBOM evidence are supplied by a future release lane.

## Target architecture

```text
Browser GUI
  |
  | typed commands; no direct file authority
  v
Local host process
  |-- immutable source document
  |-- derived revisions + undo journal
  |-- explicit save/export broker
  |-- local job queue with CPU/memory/time limits
  |
  +--> PDF renderer/indexer worker
  +--> document transformation worker
  +--> out-of-process local plugins over bounded RPC
          |-- OCR
          |-- signing
          |-- redaction
          |-- accessibility
          |-- AEC
          `-- prepress
```

Do not introduce an iframe-based executable plugin runtime. A script-capable
iframe can still have ambient browser networking unless a separate enforced
child policy exists. The production plugin host should instead launch
local, least-privilege worker processes with:

- an immutable package root, package hash, publisher identity, and exact
  dependency versions;
- no network permission in the first release;
- a fresh per-activation channel and nonce;
- grants bound to plugin ID, version, package hash, document session, operation,
  and expiry;
- method-specific request and response schemas plus byte, depth, time, CPU, and
  memory limits;
- disposable derived revisions; plugins never receive permission to overwrite
  source files; and
- fail-closed cancellation, crash cleanup, upgrade, and rollback behavior.

## Engine-selection gate

No engine should be added merely because it is popular. Run a recorded license,
format-coverage, malformed-input, determinism, and packaging spike first.
Promising local candidates include:

- PDF.js for controlled rendering, text extraction, navigation, and forms UI;
- qpdf for structure-preserving page operations, encryption, linearization,
  inspection, and repair;
- Apache PDFBox for creation, manipulation, forms, signing, rendering helpers,
  and baseline PDF/A preflight;
- Tesseract plus Leptonica for local OCR and image cleanup; and
- veraPDF for standards validation, subject to its MPL/GPL integration and
  packaging review.

PDF.js, qpdf, PDFBox, and Tesseract publish permissive Apache-family licenses.
veraPDF is dual MPL/GPL. Ghostscript is AGPL/commercial and must not be bundled
into this MIT project until the project makes an explicit, reviewed licensing
decision. Keep all engine additions behind explicit dependency approval.

The current alpha has delivered the authenticated loopback host, immutable
source/artifact store, revisioned session sidecars, a shared bounded process
queue, page/pixel limits, cancellable native jobs, kill/reap slot quarantine,
cumulative job workspace quotas, and operation-specific validation. A separate
durable automation lane now supplies a canonical versioned journal, one live
root owner, exact allowlisted job types and limits, idempotency, renewable
leases, cancellation, restart recovery, fixed retry, and receipts. One local
CLI operation stages a private digest-bound source and executes only fixed
Poppler inspection. It has no HTTP route, stable automation API, scheduler,
scripting language, action sequences, general job executor, retention, or
purge workflow.
The alpha includes
inspection/search/thumbnails, page composition, OCR, deterministic creation and
conversion fallbacks, Ghostscript rewrites, structured text export, bounded
raster mutation/redaction, offline embedded-signature integrity/coverage
inspection, content/pixel/annotation comparison, and 56 local
workflow operations. Narrower tested subsets now also cover fixed OCR cleanup,
page/region layout and ALTO/HTML export, review-required heuristic table grids
with formula-injection-safe CSV export, sequential batch/watch OCR, local CLI
dispatch including independently validated fixed Letter blank-PDF creation and
fixed two-source extracted-text-token JSON/CSV comparison
with stable source-digest bindings and formula-safe CSV cells,
ink/separation/overprint review, fixed-profile CMYK-targeted
normalization, fixed 2-up/4-up N-up, source-bound production-review receipts,
and an authenticated 200-page
`basic-local-review` accessibility subset with deterministic SHA-256 JSON.
That fixed review is document-bound and non-authoritative. It now includes
bounded tag-role ancestry heuristics, font embedding/ToUnicode evidence, fixed
per-rule provenance, optional macOS PDFKit assistive-access permission evidence,
and a strict atomic source/review/revision-bound remediation-proposal export.
Every proposal remains `proposed-not-applied`; no tags or PDF bytes are changed
and PDF/UA is not validated. One current image candidate can now receive
1–1000 UTF-16 units of
trimmed NFC human-authored alternative text in the canonical remediation JSON.
The host recomputes the review, matches the opaque image locator, rejects
duplicate or malformed targets and unsafe text, and keeps the operation
`proposed-not-applied`. It does not inspect image pixels to invent text, write
tags, alter PDF bytes, or claim semantic correctness or PDF/UA conformance.
Leading path-like text is rejected by the shared local-sidecar leak policy.
On macOS, an optional release-built Swift helper supplies a fixed-profile PDFKit
inventory of outline labels, annotation/widget types, permissions, metadata,
rotations, and resolved page boxes. The host privately stages and digest-pins
it, and PDFKit consumes descriptor-read data rather than reopening a path. A
second fixed-profile path now creates a separate, non-rasterized PDFKit rewrite
for exactly one metadata, page-box, selected-page absolute rotation, or inert
annotation-add category. The exact selected-page CropBox and BleedBox paths
accept one changed resolved rectangle inside the MediaBox; BleedBox must also
contain the unchanged TrimBox, while persistent rotation accepts only
0/90/180/270 degrees. These paths reject signed and no-op inputs and prove the
target after candidate/reopen while preserving every unrelated page box and
rotation. Rotation compares annotation count/subtype order; Crop and Bleed also
compare a private bounded descriptor of subtype, geometry, flags, contents digest, and action/
destination/relationship/appearance shape. Poppler independently confirms the
requested output state; BleedBox also requires a fixed 256-pixel-long-edge
source/output validation render to match for every page. This bounded check
does not claim equality at other resolutions or in other renderers. CropBox
expansion can reveal previously cropped source content. It binds the request to the source SHA-256, verifies the requested postcondition after
PDFKit reopen, reparses and renders every page with Poppler, and promotes only
the validated output digest. A source-bound profile now also fills one local
text/choice AcroForm widget, clears one non-required single-selection choice
after privately validating its current option and changed render, sets one
uniquely named unflagged checkbox on or off through a privately resolved
two-state appearance, selects one exact widget in a privately validated
canonical 2–50 option radio parent-and-kids group, or updates/removes one inert
annotation. It verifies the
exact input-byte locator and private effect
after reopen, requires checkbox raw/public state and changed raster evidence to
agree, and rejects signed, encrypted, JavaScript/XFA/calculation-bearing,
action-bearing, stale, shared, inherited, malformed, and unsafe targets. A
bounded raw active-content graph scan is repeated after reopen and rejects
catalog permissions, unsafe name trees, page/annotation/outline actions, and
active/signature field trees. Text, choice, and checkbox targets must be the
exact page-widget object exactly once in direct AcroForm `/Fields`. Radio
selection instead requires one direct parent field and an exact reciprocal
page-widget kid in a complete bounded group; orphaned, duplicated, mismatched,
or ambiguous membership fails closed. Because PDFKit may rewrite indirect-
object identity, postflight uses semantic field and group proof rather than
claiming object preservation. A separate macOS PDFKit source-bound profile now authors one local GoTo link
between existing pages. It accepts only a CropBox-contained rectangle and page
numbers, derives the target CropBox top-left internally, and proves identical
raw `/Dest` and exact `/A /GoTo /D` arrays plus the public reopened target.
URI, remote-file, named, launch, submit, JavaScript, additional actions,
forms, signatures, unsafe input action graphs, active annotation subtypes,
catalog/page/annotation associated-file entry points, media/3D/RichMedia
payload keys, and automatic page-presentation entries fail closed.
The sibling `macos-pdfkit-local-goto-remove-v1` path consumes one fully
inspected page/index/fingerprint locator, privately revalidates identical
direct `/Dest` and `/A /GoTo /D` destinations, and creates a separate copy with
exactly that reachable annotation occurrence removed. Native candidate and
private-file reopen checks preserve all remaining ordered passive annotation
descriptors plus every page box and rotation. Its compact receipt does not
expose the locator fingerprint or destination. It is not hidden-data cleanup,
orphan-byte or prior-revision scrubbing, or byte/object preservation.
Another source-bound profile appends one top-level direct bookmark to an
existing page's CropBox top-left. Its label must already be NFC-normalized and is bounded to
1,024 UTF-8 bytes, while its compact receipt retains only the label SHA-256.
Native candidate and private-file reopen checks prove the appended destination,
unchanged prior direct-destination outline tree, page boxes, rotations, and
ordered passive annotations. Sources with GoTo-action outlines fail closed
because measured PDFKit serialization changes their representation. Nested,
selected-position, replacement, named, remote, scripted, and
coordinate-controlled bookmark authoring remains outside this subset. A paired
`macos-pdfkit-outline-remove-v1` profile removes exactly one top-level leaf
selected by an opaque source-bound index/fingerprint locator. It rederives a raw
direct `/Dest [page /XYZ x y null]` destination and verifies the remaining outline tree, page boxes,
rotations, ordered passive annotations, extracted-text hashes, and fixed render
hashes at candidate and private-file reopen. It cannot remove nested or
non-leaf bookmarks, and no title, destination, coordinate, or fingerprint enters
the receipt. Page labels, tags, layers, XMP, custom Info keys, name trees, viewer
preferences, and non-passive page dictionaries fail closed instead of being
silently rewritten. A sibling `macos-pdfkit-outline-rename-v1` profile uses the
same source-bound top-level-leaf locator, changes only its decoded NFC title,
preserves the exact direct destination and position, and repeats the full
page/annotation/text/render/private-reopen proof. Its receipt retains the new
label SHA-256 but neither title nor the locator. These three profiles remain a
bounded lifecycle subset, not general bookmark editing, nesting, reordering,
or destination editing.
This is a
bounded macOS executable subset, not an incremental/object-preserving editor:
form authoring, general form logic, broad annotation editing, permission
controls beyond the four closed presets, and signature-safe save remain
missing. A platform-independent bounded transaction engine now
supports selected object updates, deterministic contiguous additions, and
opaque direct-length stream addition or replacement with canonical length and
exact-byte verification. Its generic parser additionally accepts
bounded identity, ASCIIHex, ASCII85, Flate, RunLength, or exact
ASCII-plus-Flate/RunLength xref
streams with bounded type-2 object-stream members and appends
a classic revision. The metadata, BleedBox, AEC, local-GoTo-link, and named-destination writers now use this parser
while keeping their operation-specific admission and verification. Object-stream
directories, exact member slices, same-revision generation-zero container
authority, exact repeats, and later uncompressed shadowing are verified under
fixed byte/member/version caps; recompression, orphan members, and container
reuse fail closed. Top-level bare-reference members remain deliberately outside
this subset. Decode parameters allow absent, null, empty, Flate predictor 1, or
bounded PNG predictors 10-15; RunLength requires exact final EOD and no non-empty
parameters. TIFF, multicolor, sub-byte, and general predictor decoding remain
unsupported. The platform-independent `local-incremental-goto-link-v1` product
path uses that same bounded parser and transaction layer to append one invisible
direct `/Dest [page /Fit]` link. It requires explicit integer MediaBox/CropBox
arrays on every page, an integer source-CropBox-contained rectangle, no existing
links or action dictionaries, and only whitelisted passive annotations. Its
canonical raw proof accounts for the exact page-or-Annots update, new Link
object, all unchanged effective rows including compressed provenance, Root,
Info, ID policy, exact source prefix, and classic appended revision. The host
then requires unsigned output and independent Poppler page/text/box plus fixed
256-pixel all-page render equality before digest-bound promotion. This is not
general hyperlink support, sanitization, signature preservation, or broader
semantic or print equivalence. Exact ASCII termination, ASCII85
tuple bounds, complete Flate consumption, and a 16 MiB per-scope intermediate
work budget are enforced. Branded private resolver authority and pre-build Root/Info role
validation close caller-mutation and build-versus-verify gaps. A separate bounded
compact rewrite now follows only effective Root and optional Info references,
preserves stable object identities, IDs, the admitted PDF version, and exact
opaque stream payloads, expands reachable compressed members, and emits one
deterministic closed classic revision. Its branded descriptor and independent
digest-bound reparse reject tampering, reachable signatures or controls, residue, history,
and unreachable live objects under 512 MiB source, 10,000-object, and 256 MiB
output caps. A separate internal logical-deletion primitive now binds opaque
target handles to one exact parsed source, admits only current ordinary
uncompressed objects under a complete validated free list, and checks the
post-transaction graph for surviving inbound references. Historical and
planned signature evidence, Root, Info, controls, compressed targets,
collisions, and malformed chains fail closed. The append uses sorted,
generation-incremented classic free rows and a branded verifier independently
rebuilds, reparses, and checks the exact effective chain. Old bodies remain in
the byte-preserved source prefix and freed numbers are not reused. A fixed
JavaScript-removal product profile now composes these primitives under a
separate exact safety and verification contract; neither primitive alone
promotes a capability or sanitization claim. General stream
decoding/filter semantics, unrestricted targeted deletion, arbitrary object discovery, and
cross-profile semantic verification remain missing. The same helper now has one fixed password-protection derived-copy
profile: AES-128/R4/V4/AESV2 only, a printable-ASCII 12–16 character open
password and a distinct 12–32 character owner password, and only the measured closed advisory profiles
`deny-all`, `accessibility-only`, `print-only`, and `copy-accessibility`.
It accepts at most 100 pages/128 MiB and rejects encrypted,
tagged, form, JavaScript, signed, attachment-bearing, and URL-bearing sources.
Credentials cross token-authenticated same-origin loopback HTTP as bounded JSON
and then bounded private stdin. They are not intentionally retained in app
state, files, results, provenance, argv, or application logs; fields and mutable
request buffers are cleared after use, while developer tools, instrumentation,
and runtime memory may retain transient copies. The
immutable source is retained and the derived output is encrypted-envelope,
unauthenticated-open, PDFKit-reopen, Poppler-render, and digest validated. It
does not provide arbitrary permission combinations, selectable AES/AES-256,
recovery, or certificate encryption. A distinct executable subset now removes
protection only from an exact current-session artifact produced by this fixed
boundary. It binds the retained protection provenance, permission profile,
digest, and page count; requires a fresh locked PDFKit document and exact owner
status before copying; rejects active/unsupported graphs; rebuilds pages and
bounded local outlines in a fresh document; and privately proves boxes,
rotations, passive annotations, stable metadata, outlines, text, and renders
match after no-password reopen. The host independently proves a final classic
trailer with no `/Encrypt`, passive no-password Poppler inspection, matching
page count, every-page rendering, and promoted digest. The cleartext host
artifact is consumed after its transfer. The encrypted artifact and immutable
source remain. Recovery/cracking/bypass, arbitrary decryption, secure erasure,
legal ownership proof, signature-safe rewriting, sanitization, redaction, and
byte/object preservation remain outside the subset. Signed/notarized packaging
and native sandbox containment remain open. Signed package verification, immutable installs,
scoped grants/handles, rollback, and bounded RPC are present as a fail-closed
foundation. Active launch descriptors now rehash after dependency resolution;
incremental input/output frame quotas, backpressure, one-shot binding, and
activation-wide cleanup are deterministic host-only services. The private RPC
transport now admits only the broker-bound request count, keeps no pending
request queue, reserves one bounded in-band cancellation lane, serializes
response writes, and closes authority before fallible stream teardown. A strict 64 KiB
canonical worker-control codec now binds exact capability invocation,
completion, sanitized failure, and cancellation messages without exposing
paths or executable authority. Package activation also
rereads metadata and signed inventory through bounded no-follow, single-link
descriptors with fatal UTF-8 and pre/post identity checks. Executable OS sandboxing,
durable revision journals, hostile cross-platform corpora, and packaging gates
below remain open.

The current macOS behavior probe observes fixed Seatbelt canary denials for
network, writes, sensitive-root reads, and process creation, but its diagnostic allow-default
profile cannot satisfy the production `osSandbox` requirement. Fixed Node
permission canaries add defense-in-depth observations for filesystem,
child-process, worker-thread, and network APIs without being treated as a
malicious-code sandbox. An inherited one-CPU-second `RLIMIT_CPU` canary is also
observed but does not satisfy the production CPU gate. The execution
gate independently requires CPU, hard-memory, process, and output quotas; V8
heap caps and RSS watchdogs remain best-effort evidence only. No plugin code is
launched by the probe or operation-session services.

## Roadmap coverage of the 277 planned professional records

This table assigns every missing normalized catalog record to a phase or an
explicit policy exclusion. A phase assignment is sequencing, not implementation
evidence.

| Capability family | Missing | Roadmap disposition |
| --- | ---: | --- |
| View and navigation | 10 | Phase 1 |
| Create and convert | 17 | Phase 2 |
| Content editing | 20 | Phase 4 |
| Page organization | 7 | Phase 2 |
| Annotations and review | 18 | Phase 3; networked review variants excluded |
| Forms | 15 | Phase 3 |
| Signatures | 13 | Phase 6; local keys and offline validation only |
| Scan and OCR | 7 | Phase 5 |
| Security | 9 | Phase 6 |
| Redaction and sanitization | 11 | Phase 6 |
| Comparison | 9 | Phase 8 |
| Accessibility | 15 | Phase 7 |
| Standards, preflight, and print | 26 | Phase 8 |
| Collaboration and DMS | 12 | Phases 3, 9, and 10 for local project substitutes; remote records excluded |
| Automation and headless | 13 | Phase 10; webhooks excluded |
| AI | 15 | Excluded in full |
| AEC | 18 | Phase 9; networked session delivery excluded |
| Rich media, 3D, and portfolios | 13 | Phase 10, beginning with safe inspection |
| Integrations and administration | 18 | Phase 10 for local adapters, policy, packaging, and reporting; remote records excluded |
| Plugin platform | 11 | Phase 0 and subsequent engine phases |
| Total | 277 | 262 non-AI records assessed; 15 AI records excluded |

The following records cannot be delivered as their researched remote service
without violating this roadmap's no-egress boundary and therefore remain
`planned`: `sign.routed-workflow`, `sign.timestamp`,
`sign.identity-verification`, `collaboration.share-links`,
`collaboration.real-time-review`, `collaboration.activity-notifications`,
`collaboration.access-expiration`, `dms.repository-connectors`,
`dms.offline-sync`, `automation.webhooks`,
`aec.collaborative-review-sessions`, `integrations.cloud-storage`,
`integrations.email`, `integrations.esign-providers`,
`integrations.events-webhooks`, `admin.audit-telemetry`, and `admin.sso-scim`.
All 15 `ai.*` records also remain planned and are not implementation targets.

Local substitutes - ordered approval logs, embedded timestamp validation,
portable review bundles, local version history, file import/export, local audit
logs, and an IPC-only API - must receive distinct evidence and must not be used
to claim the excluded remote record.

## Delivery phases

### Phase 0  -  foundation and safety gates (partially delivered)

Delivered in this phase: signed canonical packages, scoped publisher trust,
immutable content-addressed storage, exact dependency resolution, activation
rehashing, registry and rollback, scoped grants and opaque document handles,
bounded incremental RPC transport, one-shot cleanup composition, and a
fail-closed granular execution gate. Manifest v3, the concrete native host
adapter, signed-release-policy contract, private two-phase pipe protocol,
strict static/live identity validation, exact entitlement policy, activation
quarantine, and split Swift supervisor/worker source are also delivered. The
current macOS diagnostic sandbox probe
does not promote runtime execution. Its authenticated GUI status bridge is now
delivered: exact empty request, host-session in-flight/final cache, sanitized
fixed response, strict client validation, and a visible hard-control versus
best-effort evidence split. It always reports execution blocked.

1. Package the delivered supervisor/worker as a Developer-ID-signed,
   hardened-runtime, notarized macOS App Sandbox helper pair and seal its
   release policy in the signed host. Replace the currently unavailable
   meaningful `RLIMIT_AS` ceiling with a supported hard-memory control, then
   define equivalent process containment for Windows and Linux. Prove
   network, filesystem, process-tree, CPU, memory, descriptor, IPC, output, and
   native-loading denial with adversarial canaries before changing any hard bit.
2. Extend the delivered immutable source/artifact model with a revision
   journal, undo/redo, explicit save promotion, and crash recovery.
3. Connect the delivered process broker to activation only after every packaged
   hard-control test passes; keep the current non-bypassable dispatcher closed
   while any ready bit is false.
4. Add a hostile-PDF corpus, fuzzing entrypoints, resource ceilings, golden
   renders, byte-identity checks, and cross-platform packaging tests.
5. Decide the project license and produce a third-party license/SBOM gate before
   approving any engine dependency.

Exit gate: a deliberately malicious plugin cannot access a document, network,
clipboard, camera, arbitrary path, or another plugin; a crash cannot corrupt the
source document.

### Phase 1  -  controlled viewer and document index (prototype subsets delivered)

Build beyond the delivered native viewer, passive selected-page CropBox Poppler raster
mode through a dedicated authenticated route with only document ID, page, and
integer 36–240 DPI mapped to a capped longest edge, immutable source/page
inspection, private-workspace bounded PNG validation, and no PDF-action
execution. A delivered sibling snapshot route accepts one six-decimal
normalized top-left region, validates PNG structure/CRC/decompression bounds,
uses floor/ceil pixel coverage, and supports explicit PNG clipboard copy or
download without mutating the PDF. It preserves no text, vectors, links, tags,
layers, forms, or PDF object structure. A delivered fixed-240-DPI inspector
loupe reuses that region while keeping the native full-page context visible;
its abortable decoded Blob URL is revoked on every relevant context change.
Thumbnails remain on their separate fixed profile. Basic extracted-text search
and the optional macOS PDFKit helper's bounded local-page outline and logical-
label navigation are delivered. Outline inventory is capped at 200 entries and
eight levels, and only raw direct destinations or restricted GoTo actions can
navigate; unsupported and ambiguous action dictionaries remain inert. Logical
labels are retained for at most 100 pages and the first 20 are displayed. These
labels are exact through 1,024 UTF-8 bytes; longer values fail the inventory
instead of being silently truncated. A separate fail-closed Poppler inventory
retains at most 200 named destinations and exposes only validated local physical-
page navigation; it does not expose coordinates, zoom, actions, lookup, or
authoring. Separate from that read-only inventory, the strict
`local-incremental-named-destination-v1` subset appends exactly one bounded
ASCII name with one existing-page `/Fit` target when the source has no prior
destinations or page annotations. The bookmark subsets likewise append one or
remove one exact top-level leaf. These profiles do not provide general
destination or bookmark management, page-label authoring, or numbering, and
cannot edit, reorder, or nest existing bookmarks. Attachment names, document/resource properties, adjacent-page split
view, extracted-text reflow, browser read-aloud, grid, presentation chrome,
bounded navigation history, and inert link and optional-content inventories are
also delivered as narrower behaviors. An explicit page-text action copies only
the trimmed, nonempty Poppler extraction for the current physical page, up to
20,000 UTF-16 units, through the available browser text Clipboard API.
Document-operation and page-generation checks suppress stale success; a
browser write completed during a page change cannot be undone. Structure-aware
controlled rendering, arbitrary native-viewer text selection/copy, broader
navigation authoring, layer toggling/render control,
complete page layouts, tabs, freehand/drag snapshot selection, guides, and
snapping remain. The delivered
raster mode intentionally exposes no PDF actions, vectors, tags, forms, layers,
or selectable text.

The delivered optional macOS PDFKit helper adds bounded navigable GoTo
outline and link destinations, PDFKit-resolved logical labels, inert URL/
remote/named link-action records, optional-content catalog group names,
annotation/widget type counts, non-sensitive button control kinds, permissions,
metadata, rotations, and resolved page boxes for review. Annotation and widget records include opaque SHA-256
locators bound to the exact source bytes and original page annotation index;
contents, widget values, button states, export/on-state names, and appearances
remain undisclosed. Its derived-copy profiles perform one validated metadata,
page-box (including the exact persistent selected-page CropBox and BleedBox paths), selected-
page persistent-rotation, annotation-add, text/choice form-
fill, non-required single-choice clear, bounded checkbox on/off transition,
canonical radio-option selection, or inert annotation update/removal operation.
Push controls remain inventory only. They deliberately omit
general navigation/destination and layer authoring beyond the delivered single
local GoTo link plus append-one/exact-leaf-removal top-level direct bookmark subsets, layer
toggling, exposed widget values, XFA,
tags, arbitrary objects, general mutation, and any byte/signature-preservation
claim.

Exit gate: deterministic renders and extracted text/page geometry for the test
corpus; active PDF JavaScript, media, attachments, and external links remain
disabled by default.

### Phase 2  -  page model, creation, conversion, and export (substantially prototyped)

The prototype now has merge, extract, split, reorder, delete, insert, replace,
duplicate, reverse, interleave, blank insertion, page-count rule splitting,
one exact cross-document page copy,
and a macOS-only fixed rule that re-inspects the source and splits at 2–100
titled, resolved, strictly increasing top-level outline starts beginning at
page 1. That bookmark subset omits titles from outputs/provenance, rolls back
partial artifacts, and caps aggregate output at 512 MiB. It does not cover
nested/selected bookmarks or prefatory pages before the first bookmark.
The cross-document profile privately stages and digest-binds two distinct
1–100-page sources, copies one selected secondary page after an exact primary
page, and leaves both sources unchanged. Before composition, a bounded raw
graph scan rejects malformed page trees, catalog-level structures, outlines,
optional content, annotations, and actions; Poppler rejects the remaining
active or document-level surfaces. Promotion requires exact ordered equality of
page geometry, normalized extracted-text hashes, and fixed 256-pixel render
hashes. General page transfer and byte, object, structure, or signature
preservation remain future work.
Other prototype paths include selected-page PNG, raster crop/rotation/resize, blank/text/clipboard creation,
mixed-file combination, supported image/Office/OpenDocument/passive-HTML/
PostScript conversion, text/RTF/HTML/XML export, and Ghostscript rewrite paths.
A local CLI `snapshot-region` executable subset exports exactly one normalized
top-left CropBox region from the existing source-bound private Poppler
raster/crop pipeline at bounded DPI to an exclusive PNG. It exports raster
bytes only: text, vectors, PDF objects, and professional export parity remain
outside the subset, so `export.selected-region` stays planned for professional
delivery.
One macOS-only PDFKit subset now persistently changes one selected page's
CropBox or BleedBox within its MediaBox, or rotates it to an absolute
0/90/180/270-degree orientation in a derived rewrite, with native preservation
proof and independent Poppler confirmation. BleedBox must contain the unchanged
TrimBox and preserve every ordinary page render. MediaBox, TrimBox, and ArtBox
edits remain narrower prototypes. Still implement
cross-platform structure-preserving crop and page-box/rotation equivalents,
page-label authoring, broader bookmark plus blank/text/size split rules, layout-faithful
HTML/CAD and legacy Office conversion, editable Office exports, broader
selected-region export, measured compression, and independently verified
linearization.

Exit gate: source bytes remain unchanged, every transformation produces a
separate revision, and page/content invariants are checked before export.

### Phase 3  -  annotations, review, and forms (sidecars plus targeted native subsets)

The platform-independent `local-square-annotation-flatten-v1` profile now
provides one narrow `review.annotation-flatten` executable subset. It consumes
the existing PDFKit opaque locator for the sole annotation in the document,
rederives that locator from the raw immutable source, and accepts only an
indirect printed `/Square` with one tiny unfiltered, resource-free normal Form
appearance on an unrotated page with direct resources and no existing
XObjects. A deletion transaction promotes that exact appearance into page
content, removes the annotation occurrence, and is compacted to one closed
classic revision. Canonical rebuild and separate raw reinspection require the
removed reference to be unresolvable, no reachable annotations, unchanged
appearance bytes, exact page-resource/content binding, preserved Root/Info/ID
policy, and no prior revisions. Poppler must also match page count, text,
boxes, and every fixed 256-pixel render and report an unsigned output.
Multiple annotations, other subtypes, appearance states, filters, resources,
groups, optional content, actions, popups, widgets, rotations, and broader
graphs remain unsupported. General flattening and form flattening remain work.

The macOS PDFKit path can add one non-action-bearing sticky-note, free-text,
square, circle, or highlight annotation. A separate exact-source profile adds
one inert straight line between distinct CropBox-contained points, computes
its bounds internally, fixes both ending styles to `None`, and privately proves
its public/raw endpoint geometry and annotation-count delta after reopen;
contents and coordinates are omitted from the receipt. A sibling source-bound
profile adds one inert open ink path containing 2–32 CropBox-contained points,
derives its bounds internally, and privately proves one public path plus exact
raw `/InkList` geometry and the annotation-count delta after reopen; its
contents and points are likewise omitted from the receipt. Popup/Parent
relationships are accepted only as reciprocal inert direct members of the
same page annotation array, and hidden related objects fail closed before and
after mutation. Update or remove remains limited to
one inert free-text, square, circle, or highlight annotation in a separate
derived PDF. Removal now supplies a narrow `sanitize.selective-content`
executable subset: a private ordered raw/public descriptor snapshot for every
reachable page annotation must match after reopen with exactly the selected
page/index descriptor occurrence omitted, and raw annotation identity must be
unique across the whole document. It does not claim redaction, all-comment removal,
hidden-data cleanup, orphan-byte scrubbing, prior-revision removal, or arbitrary
object preservation. The exact-alpha
`forms.source-bound-acroform-fill-save` can fill one source-bound terminal
text/choice AcroForm widget,
clear one non-required single-selection choice after private option/render
validation, or set one unique, named, unflagged, privately validated two-state
checkbox on or off, or select one exact widget in a canonical 2–50 option radio
parent-and-kids group in a separately validated non-rasterized derived copy.
`forms.fill-save` remains the planned professional umbrella with only an
executable-subset ledger tier. Updates may regenerate the target appearance;
multi-select, form authoring/detection/validation/calculation/actions,
noncanonical or deeper nested/shared-field semantics, XFA, data interchange, form flattening,
and byte/signature preservation remain unsupported; push-button mutation,
noncanonical/deeper radio graphs, passwords, and signing remain unsupported. A
narrow `forms.signature-fields` executable subset now prepares exactly one
empty unsigned `/FT /Sig` widget in a source-digest-bound derived copy under a
strict classic single-revision profile. It is preparation only: signing,
certificate or key custody, appearances, timestamps, signer identity, and LTV
remain unavailable. Read-only inspection
classifies checkbox, radio, and push-button controls without exposing their
state, export/on-state name, or appearance data. Checkbox mutation likewise
returns none of those private details. Radio field/group names remain visible
in the bounded widget inventory, while radio selection omits option state
names, the prior selection, and appearances. It cannot
materialize sidecar state automatically or preserve arbitrary appearance
streams. Promote the remaining delivered local JSON sidecars to
embedded PDF objects. Implement
text/drawing/note/callout/stamp/file/measurement annotations,
properties, FDF/XFDF interchange, summaries, filters, statuses, general multi-annotation flattening, and
local review tracking. Extend AcroForm fill/save beyond the delivered bounded
text/choice, choice-clear, and checkbox subset; add field authoring and detection,
validation, calculation, data interchange, tab order/tooltips, actions,
barcodes, signature fields, flattening, and explicitly bounded XFA inspection.

Networked shared review, mentions, notifications, and remote form collection
remain excluded. A local project file may record participants and review state
without transmitting it.

### Phase 4  -  content editing and document authoring

The first platform-independent object-preserving slice now replaces four
standard Info fields on a bounded classic-xref or admitted xref/object-stream
source by appending one fresh
Info object and revision. It preserves the original bytes and prior object
offsets, retains non-target Info entries, and has separate raw reinspection plus independent Poppler,
content, render, signature, source-identity, and artifact-digest proof. It
rejects unsupported control streams, encryption, signatures, reachable XMP,
catalog permissions, ambiguous repair, and detected form/JavaScript/
attachment/URL inputs. Prior metadata remains recoverable, so it is not
sanitization or privacy removal. The shared transaction layer snapshots bounded
arbitrary AST values and opaque direct-length stream bytes, updates selected
existing objects, allocates named contiguous generation-zero additions with
branded forward/backward references, canonicalizes stream length, and reparses
the exact appended output with byte-for-byte stream verification. The same
platform-independent transaction path can append one direct `/Dest [page /Fit]`
local GoTo link on its separately bounded passive profile, with exact-prefix,
canonical-tail, xref-delta, Poppler content/box/render, unsigned-output, and
digest-bound proof. A second bounded profile appends one direct Catalog
name-tree entry for an exact 1–64-character ASCII name targeting one existing
page with `/Fit`. It requires zero prior destinations, no Catalog name tree or
legacy `/Dests`, explicit integer page boxes, no page annotations, and a passive
unsigned graph. Raw append proof plus Poppler destination, content, box,
fixed-render, unsigned-output, source-identity, and digest checks precede
promotion; receipts retain only the name SHA-256. The macOS derived-copy
fallback can replace the same fields across a different bounded subset and
author one strictly local GoTo link with raw and reopened proof. These paths do
not provide arbitrary XMP authoring, general hyperlink or destination
management, or unrestricted structure editing. Implement text
and paragraph editing, image/vector/link/object editing beyond that link subset,
find/replace, local spellcheck, headers/footers, watermarks, backgrounds, Bates
numbering, bookmarks, destinations, attachment addition, user-facing extraction,
rename and multi-attachment management, layers, XMP and custom
metadata, and scoped
flattening. The platform-independent
`local-document-javascript-removal-v1` profile removes exactly one indirect
ordinary uncompressed Catalog `/OpenAction` script or one flat Catalog `/Names
/JavaScript` entry from a 64 MiB classic-xref source. It verifies logical
deletion, emits one closed classic rewrite without prior revisions or
unreachable objects, and requires separate raw plus Poppler page/text/box,
fixed-render, unsigned-output, source-identity, and digest proof. Other actions,
forms, signatures, attachments, XMP, URLs, tags, layers, streams, compressed or
shared targets, and unsupported graphs fail closed. This is the narrow
`security.javascript-controls` executable subset, not JavaScript authoring,
execution, allowlisting, broad action editing, or hidden-data sanitization.
The sibling `local-document-attachment-removal-v1` profile removes one exact
flat document-level attachment from a 64 MiB classic-xref source. Admission
requires one unshared Filespec and one direct-length unfiltered embedded stream
capped at 8 MiB, with matching 1–240-byte printable-ASCII name-tree and Filespec
names; an optional exact `/PageMode /UseAttachments` hint is removed. The host
privately extracts attachment 1 to bind its name digest, content
digest, and byte count, then requires logical-deletion proof, one separately
reinspected closed rewrite, zero Poppler output attachments, unchanged page
count, text, boxes, fixed 256-pixel all-page renders, unsigned output, immutable
source identity, and a digest-bound artifact. Public results omit the name and
content. Actions, forms, signatures, active content, XMP, URLs, tags, shared
targets, multiple attachments, and unsupported graphs fail closed. This moves
`document.attachments-manage` from blocked to executable-subset coverage, but
does not provide addition, user-facing extraction, rename, or multi-attachment
management and does not promote the planned professional claim.
Execution stays disabled until a separate security design exists.

Exit gate: font substitution, text metrics, clipping, color spaces, object
references, incremental updates, and visual diffs are fixture-tested.

### Phase 5  -  OCR plugin (7 professional records plus tested subsets delivered)

Build beyond the delivered installed-language selection, rasterized searchable
output, fixed cleanup presets, normalized page/region recognition, strict
TSV/ALTO and positioned-HTML export, review-required heuristic TSV-geometry
table grids with formula-injection-safe CSV export, and bounded sequential
batch/watch OCR. Searchable document jobs also accept a bounded per-job user
dictionary through a private host-created Tesseract word file; only its count
and digest enter result evidence. This is vocabulary guidance, not model
training or guaranteed correction. The GUI also classifies the current run's bounded suspect
inventory into three fixed human-review states and exports canonical JSON bound
to the source and OCR artifact. It does not edit recognized text, mutate either
PDF, or translate OCR pixel geometry to source-page coordinates. Remaining work
is scan acquisition, feeder/duplex controls, page append, editable
reconstruction, authoritative tables, dictionary model training, interactive
suspect correction, and screenshot OCR. A local CLI scan-append subset now
ingests one PNG, JPEG, or TIFF through validated ImageMagick one-page
conversion and appends that derived page after one selected page of a
source-bound PDF through copy-page composition. Hardware acquisition,
duplex/feeder control, and broader scan workflows remain planned.

Exit gate: page size/count and source pixels are preserved unless the user
selects cleanup; confidence and suspect corrections are recorded; language
packs are local and checksummed.

### Phase 6  -  signing, security, and redaction plugins (planning plus verified subsets)

Implement local handwritten/electronic appearances, platform-keystore digital
IDs, certificate application/validation, certification, trust stores, embedded
revocation/LTV evidence, visible appearances, audit evidence, and local batch
sign/seal. Keep private keys host-owned and require fresh confirmation for every
signature.

Add certificate encryption, arbitrary permissions, protected view, security
policy, broad standards-compliant protection removal, selectable AES profiles,
and JavaScript controls beyond the delivered one-locus removal subset. Keep recovery/cracking/bypass and arbitrary decryption
unsupported beyond the current-session fixed-artifact subset. Then deliver
mark/preview/apply redaction, deterministic pattern search, overlays, page and
batch redaction, reports, metadata removal, and selective sanitization.

The current `sign.validate-certificate` executable subset retains independent
Poppler integrity/coverage inspection through an isolated host-owned NSS
directory and fixed `-nocert`/`-no-ocsp` policy. It strictly returns embedded
signature cryptographic integrity and full or prior-revision coverage only; raw
tool output and paths do not cross the host boundary. Only for Poppler-valid
integrity, a second fixed pass streams each CMS through an exact pre-created
FIFO inventory in a mode-`0500` private directory. Host readers retain at most
1 MiB per signature and 8 MiB total, aborting on the first excess byte while
FIFO backpressure prevents regular-file growth. Only a successful bounded
receipt is promoted for mandatory descriptor/digest postflight. Descriptor-
reading each ByteRange-excluded direct PDF string remains defense in depth. On macOS, an
optional digest-pinned Foundation/Security/CryptoKit helper accepts bounded DER
or BER, verifies the exact detached CMS against those byte ranges, and then
evaluates its certificate path. It uses `SecPolicyCreateBasicX509` and evaluates
every record at one captured host-current time against the current Mac trust
configuration, disables certificate fetching, and verifies that it remains disabled. Unsupported
subfilters, malformed CMS/BER, signature mismatches, and bounded-resource conditions fail
closed. Poppler integrity/coverage is explicitly engine-scoped; missing or
indeterminate exact-CMS prerequisites make the overall conclusion indeterminate,
and the UI prioritizes negative records and discloses omitted counts. This bounded path result is not offline/no-Keychain validation and
does not establish signer identity, PDF-signing key usage, signing-time
validity, trust elsewhere, revocation, OCSP, CRL, LTV, trusted timestamps,
DocMDP/certification permissions, legal effect, or any signing claim;
unsandboxed native parsing remains a residual risk. The signing capability tier
and count remain unchanged while the full capability stays prototype/planned.

The current `verified-raster-burn-v2` redaction subset binds declared source
text transiently to an unrotated selected region or the entire selected page
whose CropBox matches its MediaBox, rasterizes every output page,
requires opaque-black target pixels and exact non-target pixel equality, and
rejects output that is not passive, unsigned, textless, attachment-free, and
object-URL-free. It remains a destructive image-only subset, not object-level
sanitization; rotated pages and differing CropBox/MediaBox geometry are unsupported.
Every source-side native stage uses one digest-bound, no-follow, single-link
private mode-`0400` job copy, which is identity/digest revalidated before
promotion along with the store source.

The delivered source-bound redaction-plan bridge is narrower than the planned
mark/preview/apply capability. A reviewed full-page or normalized CropBox
target is inspected against the immutable private source: host-derived page
geometry and normalized text are bound to source/page/geometry evidence using
a per-process HMAC. Internal plans retain only the HMAC digest and text
length - never plaintext text, excerpts, or the key - and the browser-facing plan
strips that private binding metadata. Creation changes no PDF bytes.
Application accepts source digest, workspace revision, plan ID/digest,
and mark IDs only. It acquires a workspace read lease; rejects stale, tampered,
or legacy plans; rechecks source and page geometry; then uses transient local
text solely to invoke `verified-raster-burn-v2`. It emits a separate image-only
derived artifact while the source and plan remain unchanged and the plan stays
`proposed-not-applied`. The separate `source-bound-redaction-plan-report-v1`
subset exports one selected strict proposal under the same source digest and
workspace read lease. Its canonical, bounded JSON contains only the source,
revision, plan, profile, and public geometry bindings plus a report digest. It
omits extracted text, private HMAC and page-geometry evidence, paths, artifact
links, and application claims; it changes no PDF bytes and is neither a
certificate nor an application report. This bridge neither enables generic `redaction.apply`
nor promotes a professional delivery tier. Object-level redaction,
hidden-data/metadata/layer/attachment and prior-revision removal, signature
preservation, search/detection, batch workflows, applied-redaction reports, and selective
sanitization beyond the separately documented subsets remain planned or
unsupported.

The current `sanitize.selective-content` executable subset removes one exact
source-bound inert free-text, square, circle, or highlight annotation from a
separate PDFKit-derived output. A bounded native snapshot proves that every
other reachable annotation descriptor and its order remain unchanged after
reopen, while duplicate raw annotation identity across page arrays fails closed.
It does not scrub unreachable object bytes, incremental revisions,
metadata, attachments, scripts, layers, or other hidden content; broad
`sanitize.hidden-data` remains blocked.

The separate `macos-pdfkit-metadata-sanitize-v1` executable subset covers only
`sanitize.metadata`. It accepts a strict passive unsigned source, identifies
document Info, custom Info, and catalog XMP, and rebuilds a fresh PDFKit copy
without those categories. Native reopen checks require empty Info/no XMP plus
matching page boxes, rotations, ordered passive annotations, bounded local
outlines, text hashes, and render hashes. Independent Poppler checks require
standard/custom/XMP metadata absence, passive unsigned output, unchanged page
count, and a valid render of every page before digest-bound promotion. Sources
with encryption, forms, tags, layers, name trees, attachments, URLs, signatures,
active content, unsupported page/catalog graphs, or no removable metadata fail
closed. This is not hidden-data cleanup, orphan-object or prior-revision
scrubbing, secure erasure, signature preservation, or byte preservation.

Online identity verification, remote routed signing, live timestamp authorities,
and live revocation fetching remain excluded. Existing embedded timestamps and
revocation evidence may be validated locally.

Exit gate: independent verification rejects altered signatures and confirms
redacted targets are absent from content streams, XObjects, annotations,
metadata, attachments, OCR layers, incremental revisions, extracted text, and
rendered pixels.

### Phase 7  -  accessibility remediation and standards

Build beyond the delivered authenticated, document-bound, fixed
`basic-local-review` and its atomic proposal sidecar. Delivered evidence covers
bounded role ancestry, title/language discovery, font embedding/ToUnicode,
image/empty-text inventories, and optional macOS assistive-access permissions;
delivered proposals cover human-reviewed tag, reading-order, heading/list,
table, form, link/bookmark, artifact, alt-text, language/title, and contrast
work without applying it. A narrower delivered executable subset can add only
the missing document-default language and Info title to a separate append-only
copy after a current source-bound review. It preserves the source as the exact
prefix and validates raw structure plus page, text, box, and render evidence;
historical metadata remains recoverable, and content-item language, tagging,
structure repair, conformance, sanitization, and signature preservation remain
unavailable. Implement an approved structure-preserving tagged-PDF
writer, reversible tag-tree/reading-order UI, and authoritative postflight.
The host now has a separate fail-closed veraPDF boundary, fixed PDF/A and
PDF/UA profile allowlist, strict one-job JSON normalizer, source/bundle digest
receipt, authenticated route, client, and GUI state. It accepts only an exact
1.30.1 distribution whose full transitive file inventory is read-only and
SHA-256 manifested; it never searches PATH or accepts custom/automatic
profiles. No such bundle or pinned-version stdout/corpus fixture is shipped,
so the product gate remains disabled and semantic review continues to report
PDF/UA conformance as `not-checked`. PDF/X needs a separate authoritative
engine.

Exit gate: PAC/veraPDF-style fixtures and assistive-technology smoke tests agree
on expected structure; automatic changes remain reviewable and reversible.

### Phase 8  -  comparison and prepress plugin (review and fixed-artifact subsets delivered)

Build beyond the delivered bounded extracted-text, rendered-pixel, local-sidecar
annotation, batch API, and JSON/CSV comparison reports. Implement rendered
overlay/side-by-side, conversion-backed cross-format comparison, package
comparison, alignment controls, and thresholds. Then implement PDF/A, PDF/X,
PDF/UA, PDF/E, PDF/VT, and PDF 2.0 validation; custom profiles, fixups, Certified
PDF history; OutputIntent authoring, existing-CMYK retargeting, and spot-color
control; output/separation/ink/overprint/transparency analysis beyond the
delivered bounded Ghostscript review evidence; and custom/imported profile
execution beyond the delivered fixed non-certifying print/archive reports. The
current artifact subset binds the exact installed Ghostscript CMYK printer
profile, performs CMYK-targeted normalization, and creates deterministic fixed
2-up/4-up row-major N-up without printer marks. Remaining work includes soft
proof, trapping, bleed/production marks, booklet/signature/creep and
step-and-repeat imposition, font embedding/fixups, image control, variable data,
barcodes, and production decoration.

Exit gate: use published conformance suites where available, fixed ICC assets,
golden separation renders, deterministic machine-readable reports, and
object-level assertions for every fixup.

### Phase 9  -  AEC plugin (bounded sidecars, calculations, and portable bundle delivered)

Promote the delivered bounded geometry/workflow records into complete
PDF-native AEC objects and multi-document project artifacts. Extend the current
source-bound calibration and distance/perimeter/area/count calculations and the
optional PDFKit materialization of one selected result as an inert line, ink,
or circle annotation. Calibrated geometry now receives a separately verified,
append-only `/Measure` dictionary on the page viewport; a two-point line also
receives `/Measure` and `/IT /LineDimension`, while count remains intentionally
uncalibrated. Implement complete measurement types, reusable markup toolsets,
markups lists, formulas, spaces, sheet sets/logs, metadata tags, overlays, slip
sheets, broader batch links, legends, local/offline projects, review status, geospatial
inspection, and quantity takeoff.

The `aec.batch-link` executable subset appends 1–50 same-document direct
`/Dest /Fit` links in one append-only revision for strict unsigned/passive
sources. External, cross-file, named, and action links fail closed, and
bounded indirect stream `/Length` admission is engine compatibility evidence
only, not an authoritative AEC or professional batch-link claim.

Networked review sessions remain excluded. The delivered canonical workspace
bundle can be exchanged manually between sessions holding byte-identical source
PDFs; a separate self-contained portable bundle includes the exact PDF plus the
integrity-checked revisioned workspace. Neither contains paths, credentials,
executables, or network project state. Broader ISO/PDF measurement semantics
and multi-document project packaging remain to be implemented.

Exit gate: known-scale fixtures produce exact unit-aware results; invalid or
mixed calibration fails closed; every quantity retains sheet revision and
measurement provenance.

### Phase 10  -  local automation and safe specialist content

Build beyond the delivered strict blank-creation/inspect/text/OCR/layout/prepress and
two-source content-comparison CLI,
no-clobber output broker, manifested sequential OCR batch, and stability-gated
bounded OCR watch session. Named CLI prepress operations now also publish
validated CMYK/N-up artifacts, deterministic production-review JSON, or complete
digest-bound preflight JSON/XML without overwriting existing paths. The durable
queue described above now has one
allowlisted inspection executor with private source custody, CLI submit/run/
status/pending-cancel commands, lease renewal, and restart-safe receipts. It
deliberately leaves an unclean owner lock fail-closed and permanently counts
terminal jobs and retained sources against fixed quotas. Add a stable local API
socket, additional allowlisted executors, active cross-process cancellation,
administrative stale-lock recovery, reference-aware retention and purge,
action sequences, constrained scripting,
schedules, conditions, variables, batch print, and local preflight service. Add safe inspection of portfolios,
embedded files, layers, 3D/geospatial metadata, and rich media before any
authoring or playback.

Webhooks, cloud/DMS connectors, remote storage, e-sign providers, SSO/SCIM,
cloud licensing, remote telemetry, and any other egress feature stay outside
the local-only product.

## Production promotion gate

The alpha catalog uses `implemented` for a narrow runnable behavior with exact
checked-in evidence; it is not a production certification. Before any such
behavior is promoted beyond alpha, all of the following must be
present:

1. a concrete local engine and exact owner;
2. permission, input, output, cancellation, and failure contracts;
3. deterministic unit and integration fixtures, including malicious input;
4. visible GUI loading, empty, error, progress, cancellation, and success states;
5. accessibility and keyboard checks for its GUI;
6. output integrity or conformance verification appropriate to the function;
7. dependency license and SBOM evidence; and
8. catalog evidence pointing to the exact tests, not descriptive prose.
