# Capability coverage

## Reading the map

The authoritative source is `catalog/capabilities.json`, reconciled from
`catalog/capability-proofs/proofs.json`. `implemented` is reserved for the 205
proven claims with retained evidence. `planned` covers the 20 audited partial
claims and 93 false/unavailable broad claims; it does not mean the broad
professional capability runs. No capability IDs are unaudited.

The professional catalog contains 318 normalized records. Run `npm run report`
for the live inventory. At the current candidate:

- 205 records are proven and implemented with named test evidence;
- 113 records remain planned, including 20 audited executable/limited partials
  and 93 false/unavailable broad claims;
- prototype coverage is a separate ledger over the same IDs and does not widen
  the professional claim. Planned records may have a narrower prototype
  subset, but that is not a professional implementation;
- catalog `ai.*` entries remain policy-excluded from implementation, and no
  capability ID is unaudited.

The generated [feature-gap report](feature-gap-report.md) lists every ID.

## Proven and bounded surfaces

The table below records the checked-in surfaces and their bounded scope. Some
rows are planned professional claims with narrower prototype coverage. The
generated [feature-gap report](feature-gap-report.md) is the authoritative
per-ID status and tier map. A row can also retain research context for a false
or unavailable broad claim; those IDs are blocked (or policy-excluded for
`ai.*`) and do not run.

| Area | Capability IDs | Exact scope |
| --- | --- | --- |
| Intake/lifecycle | `document.open.local`, `document.open.drag-drop`, `document.close`, `document.download.original` | Validate a selected PDF, retain/revoke its browser URL, close it, or return the unchanged `File`. |
| Native viewing | `viewer.native.render`, `viewer.zoom.preview`, `viewer.rotate.preview`, `viewer.fullscreen` | Browser-owned rendering and preview-only controls. No saved mutation. |
| Rendered region tools | `viewer.snapshot`, `viewer.loupe` | Copy or download one six-decimal normalized top-left region of the selected page's source-bound passive CropBox raster, or inspect the same region at a fixed 240 DPI while the native full page remains visible. The bounded local PNG codec verifies chunk structure and CRCs, then applies exact integer-millionth floor left/top and ceil right/bottom pixel coverage. Snapshot clipboard output is browser-permission dependent; download remains available. The loupe's abortable Blob URL is revoked on region, page, view, document, or window-context change. Both images contain no selectable text, vectors, links, tags, layers, forms, or PDF object structure and do not mutate the source. |
| Local inspection | `viewer.document-properties`, `viewer.attachments` | Poppler metadata, geometry, security indicators, font/image inventories, and embedded-file names. Attachments are never opened automatically. |
| Find/navigation | `viewer.thumbnails`, `viewer.search`, `viewer.bookmarks`, `viewer.destinations`, `viewer.page-labels`, `viewer.navigation-history` | Bounded Poppler PNG thumbnails plus page-aware search over local UTF-8 text extraction. A fail-closed Poppler named-destination inventory retains at most 200 validated local physical-page targets; coordinates, zoom, actions, lookup, and authoring are unavailable. On macOS, the optional digest-pinned PDFKit helper inventories at most 200 outline entries through eight levels from an immutable source copy; only raw direct destinations or restricted GoTo actions that resolve to an existing local page become navigation buttons, while unsupported, mixed, malformed, or unresolved actions remain inert labels. The same helper validates at most 100 resolved logical-label-to-physical-page mappings and displays the first 20 as local navigation buttons. Retained labels are exact through 1,024 UTF-8 bytes and longer values fail closed rather than being shortened. The viewer records at most 100 application-selected physical pages for the current open document; back/forward selections branch correctly and open/close resets to page 1. It does not retain viewport coordinates, zoom, rotation, embedded-viewer scrolling, destinations, persistence, or cross-document history. Safe raster mode uses a separate authenticated fixed CropBox render for one inspected page at integer 36–240 DPI mapped to a capped edge. Inspection and rendering share one descriptor-copied, digest-bound, single-link private mode-`0400` source that is revalidated afterward; the result is passive local rendering, not object preservation or layer rendering. |
| Page output | `pages.extract`, `pages.merge`, `pages.split`, `pages.reorder`, `pages.delete`, `pages.crop`, `pages.rotate`, `pages.insert`, `pages.replace`, `pages.duplicate`, `pages.reverse-interleave`, `pages.copy-between-documents` | Composition operations create separately validated PDFs with `pdfseparate`/`pdfunite`. The cross-document executable subset copies exactly one selected secondary page after an exact primary page. Both bounded sources are privately staged and digest-bound; a generic-PDF graph scan rejects malformed page trees, catalog-level structures, outlines, optional content, annotations, and actions before composition, while Poppler rejects encryption, forms, JavaScript, tags, XMP, attachments, URLs, and signatures. Exact output order must match source page boxes and rotation, normalized-text hashes, and fixed 256-pixel render hashes. Both sources remain immutable; byte, object, document-structure, and signature preservation are not claimed. On macOS, persistent CropBox, BleedBox, and rotation paths create non-rasterized PDFKit-derived copies for one selected page. Crop and Bleed accept a changed resolved rectangle inside the page MediaBox; Bleed must contain the unchanged TrimBox, while rotation accepts an absolute 0/90/180/270-degree target. All reject signed/no-op inputs and preserve unrelated boxes/rotations; rotation preserves annotation count/subtype order, while Crop and Bleed also compare private bounded subtype, geometry, flags, contents-digest, and action/destination/relationship/appearance-shape descriptors. Poppler confirms the requested output state and renders every page; fixed 256-pixel-long-edge source/output validation renders must match for BleedBox. That bounded check does not claim equality at other resolutions or in other renderers. Explicit-versus-inherited box syntax is not preserved. |
| Bounded content authoring | `edit.add-text`, `edit.text-reflow`, `edit.images`, `edit.vector-objects`, `document.layers-manage` | Create a separately retained source-bound output that performs exactly one admitted mutation: append one fixed Helvetica printable-ASCII text run to one content-empty passive page; rewrap one ASCII paragraph across 2–32 existing fixed-width unescaped `Tj` slots without changing the stream length or page geometry; insert or replace one baseline grayscale or RGB JPEG XObject; append one black 1 pt stroked rectangle to a content-empty page; or change default visibility for existing optional-content groups. These are fixed mutation profiles, not general text layout, typography, image editing, vector-object editing, layer creation, layer deletion, or arbitrary content editing. |
| Current-page speech and text copy | `viewer.read-aloud`, `viewer.select-copy` | Speak at most 20,000 UTF-16 units of trimmed locally extracted text for the ready current physical page through browser speech synthesis, cancelling prior speech and using the document language. Copy only nonempty trimmed extracted text for that page through `navigator.clipboard.writeText`, with the same 20,000-unit limit and exact operation-document, source-digest, page, and selection-generation checks around the asynchronous write. A completed clipboard write cannot be undone if state changes while it is pending; stale completion receives no success announcement. Neither path exposes arbitrary native-viewer selection. |
| Raster export | `export.images` | Render the selected PDF page to PNG through bounded `pdftocairo`. |
| Source-bound AcroForm fill/save | `forms.source-bound-acroform-fill-save` | On macOS, mutate exactly one source-digest-bound eligible terminal text, single-choice value or permitted clear, uniquely validated unflagged checkbox on/off widget, or exact option in a canonical 2–50-widget radio parent-and-kids group in a separately validated non-rasterized derived copy. Apple PDFKit performs the mutation; PDFKit reopen plus Poppler parse/render validate the output. Push controls, multi-select, noncanonical or deeper field graphs, authoring/detection/validation/calculation/actions, XFA, data interchange, signatures, flattening, and byte/signature preservation are excluded. |
| Source-bound AcroForm fill/save and validation | `forms.fill-save`, `forms.validate` | forms.fill-save updates exactly one existing terminal classic AcroForm field (Tx, Ch, canonical checkbox, or canonical radio) in a separate source-bound incremental derived PDF, preserves the source prefix, and independently reopens the exact V/AS. forms.validate performs authenticated read-only required/type/min/max validation for submitted values bound to safely inspected existing terminal fields and returns value-free errors with hashed field identifiers. Appearance regeneration, flattening, calculations, interchange, XFA, signatures, mutation, artifacts, regex/JavaScript/actions, and ambiguous or unsupported graphs are excluded. |
| Source-bound AcroForm CSV export | `forms.import-export-data` | Export the nearest inherited name and current string value of exactly one terminal single-widget Tx field from an alias-free passive classic AcroForm PDF as one canonical BOM-prefixed UTF-8 CSV row bound to the current source SHA-256. The field graph is at most two edges deep; strings are printable ASCII or bounded NFC UTF-16BE, and formula-leading cells fail closed. Import, other interchange formats, multiple or non-text fields, active content, signatures, mutation, retained artifacts, paths, and network delivery are excluded. |
| Signing intent and certificate validation | `sign.electronic`, `sign.validate-certificate` | `sign.electronic` stores one local consent-bound signing-intent record in WorkspaceStateStore against the source digest and workspace revision, retaining only signer and intent hashes. `sign.validate-certificate` uses Poppler pdfsig for offline embedded-signature integrity and current-document coverage, then reports supported exact-CMS current-host macOS X.509 path status with certificate fetching disabled. Neither path provides PDF mutation or appearance, artifacts, signer identity, signing-time validity, revocation/OCSP/CRL, LTV, trusted timestamps, certification permissions, PDF-signing key usage, cross-machine trust, routing, audit trails, external signing authority, or legal effect. |
| OCR subset | `ocr.recognize-text`, `ocr.cleanup`, `ocr.suspect-review`, `ocr.language-detection-selection`, `ocr.zones-layout`, `ocr.table-recognition`, `ocr.user-dictionaries-training`, `ocr.batch-recognition`, `ocr.export-layout-preserving` | Select installed Tesseract languages; run fixed cleanup; create a separate searchable raster PDF; inspect bounded page/region layout and review-grade table grids; run bounded sequential batches; and export positioned review data. Searchable document jobs accept at most 256 validated normalized per-job user words through a private host-owned Tesseract file; only count and canonical file digest leave the job workspace. This guides recognition vocabulary but does not train a model or guarantee correction. The GUI verifies downloaded OCR artifact size and SHA-256 and caps this contiguous browser-verification path at 64 MiB. Another executable subset classifies up to 500 current-run low-confidence suspects in the browser and exports canonical source- and artifact-bound JSON. It does not correct text, change the OCR artifact or source PDF, map raster pixels to source-page coordinates, or establish authoritative text. This is not editable or structure-preserving OCR, and tables require human review. |
| Accessibility document metadata subset | `accessibility.document-language-title` | After the current source-bound local review reports both values missing, create a separate append-only PDF that adds only Catalog `/Lang` and Info `/Title`. The fixed lowercase language grammar and trimmed NFC title are bounded; raw reinspection, private source identity, Poppler page/text/box checks, fixed all-page render equality, unsigned output, source rehash, and artifact digest binding fail closed. Historical bytes remain recoverable. Content-item language, tags, structure repair, reading order, PDF/UA or WCAG conformance, sanitization, and signature preservation are excluded. |
| Accessibility role and font evidence | `accessibility.heading-list-structure`, `accessibility.artifact-management`, `accessibility.font-unicode-mapping` | One immutable-source basic local review capped at 200 pages reports bounded Poppler heading/list role heuristics, a standard Artifact-role inventory that remains not-checked, and `pdffonts` ToUnicode/embedding yes/no/unknown counts. Remediation candidates remain proposed-not-applied. The review does not repair tags or fonts, classify decorative or repeated content, prove reading order, semantics, glyph correctness, PDF/UA, or other conformance. |
| Human-authored image alt-text proposal | `accessibility.alt-text` | After a current source-bound accessibility review reports a bounded image candidate, select exactly one opaque locator and export 1–1000 UTF-16 units of trimmed NFC human-authored text in a canonical revision-bound proposal. Missing, stale, duplicate, unknown, malformed, control/format-bearing, unpaired-surrogate, or leading path-like input fails closed. No image bytes are disclosed; the text is not inferred, applied to PDF tags, or validated for meaning, and no PDF/UA claim is made. |
| Open-password encryption | `security.open-password` | Optional local macOS PDFKit derived copy using fixed AES-128/R4/V4/AESV2, a printable-ASCII 12–16 character open password, and a distinct 12–32 character owner password. The open-password ceiling avoids a measured PDFKit owner-classification defect for lengths 17–31; this is not general encryption administration. |
| Permission-control subset | `security.permission-controls` | Four measured, closed advisory presets: deny all optional operations, accessibility extraction only, printing only, or copying plus accessibility extraction. Exact native masks, reopened public flags, and raw `/P` values are validated. Arbitrary combinations, edit/comment/form/assembly presets, and enforcement against non-conforming readers remain unavailable. |
| Plugin metadata and verification | `platform.plugins.catalog`, `platform.plugins.sandbox-probe`, `platform.plugins.package-verification`, `platform.plugins.version-compatibility` | Active signed executable-package capability metadata, a blocked cached local sandbox diagnostic, install-time canonical signature and retained-integrity verification, exact supported package/manifest/protocol/runtime validation, and activation-time dependency identity pin enforcement. The policy evaluator is advisory only, and none of these paths claims runtime isolation. |
| Source-bound AEC records and portable projects | `aec.scale-calibration`, `aec.legends`, `aec.takeoff`, `aec.markups-list`, `aec.markup-toolsets`, `aec.custom-columns-formulas`, `aec.sheet-metadata-tags`, `aec.spaces-regions`, `aec.revision-status-workflows`, `aec.revision-overlay`, `aec.batch-slip-sheet`, `aec.geospatial-documents`, `aec.offline-projects` | Record one selected-page scale, export deterministic measurement legends, aggregate bounded quantity takeoffs, create or list bounded workspace markups, persist source-bound markup toolsets, retain descriptor-only revision overlays, create source-bound slip-sheet plans, manually define and evaluate one safe arithmetic custom column, manually record one page's sheet metadata, store one bounded polygon with deterministic area and perimeter, progress a local current-source revision through draft, issued, and superseded, or manually calibrate one local affine page and convert one point at the optimistic workspace revision. Source-bound markup toolsets, revision overlay descriptors, and slip-sheet plans do not create markups, render or align overlays, replace pages, carry forward markup data, mutate PDFs, or provide remote collaboration. A separate authenticated portable-project path transfers exact PDF bytes with an integrity-checked workspace snapshot, rebasing imports to a fresh local revision. Automatic metadata extraction, pricing, inferred columns, arbitrary JavaScript, GeoPDF or CRS interpretation, geodesy, map layers, network collaboration, synchronization, remote repositories, PDF mutation, inferred geometry, multi-viewport calibration, and dynamic markup symbols remain excluded. |

The GUI additionally exposes narrower prototype behaviors for creation and
conversion, structured text export, viewing modes, raster page mutations,
rule-based splitting, verified raster redaction, document comparison, fixed OCR
cleanup and page/region layout review, bounded prepress previews, and fixed
non-certifying print/archive preflight reports with complete deterministic JSON
or escaped XML export. The local CLI can create independently validated fixed
1–500-page US Letter blank PDFs and exclusively write extracted-text
RTF/HTML/XML, complete fixed-profile preflight JSON/XML, deterministic
`basic-local-review` JSON, and fixed two-source extracted-text-token comparison
JSON/CSV without promoting their professional delivery tiers. Comparison JSON
uses stable source-digest bindings rather than private session IDs; CSV carries
both digests, neutralizes spreadsheet formula prefixes, and includes unchanged
counts. The comparison report contains extracted tokens and does not prove graphics, layout,
formatting, reading order, annotations, or PDF object equivalence.
The authenticated, document-bound `basic-local-review` checks at most 200 pages of Poppler
tag-role hierarchy, title, language, font embedding/ToUnicode, image, and
empty-text evidence and exports deterministic SHA-256-bound JSON. Unknown role
ancestry is coverage-unknown. A strict optional macOS helper can also check the
assistive-access permission while inventorying bounded outline labels,
annotation/widget types, non-sensitive checkbox/radio/push-button control
kinds, permissions, metadata, rotations, and resolved page boxes from descriptor-backed PDFKit input. Its bounded annotation and widget
records also carry opaque exact-source SHA-256 locators without exposing
contents, widget values, button states, export/on-state names, or appearance
data. Its release binary is privately
staged and digest-reverified. Resolved local GoTo outline destinations navigate
the open PDF, so that bounded macOS-only behavior is the exact-alpha
`viewer.bookmarks` implementation. Unsupported or unresolved actions remain
inert. Separate derived-copy profiles provide only the append-one and exact
top-level-leaf removal bookmark subsets described below; general bookmark
authoring is not claimed. The helper
also supports a narrow executable subset of `pages.split-by-rule`: the host
re-inspects the immutable 2–100 page source and accepts only 2–100 titled,
fully resolved, strictly increasing top-level outline starts beginning at page
1. It ignores descendants and title text, emits numeric provenance and generic
names, rolls back partial artifacts on failure/cancellation, and caps aggregate
retained output at 512 MiB. Nested/selected bookmarks, prefatory pages, blank/
text/size rules, page labels, and arbitrary object/signature/tag/form/layer
preservation remain outside this subset, so the professional record stays
planned. The helper
also provides the exact-alpha `viewer.page-labels` list for the first 100
PDFKit-resolved local pages, with the first 20 displayed and the remainder
available in the bounded JSON inventory. Each retained label is exact through
1,024 UTF-8 bytes; a longer label rejects the inventory. This is not arbitrary label lookup,
duplicate-label disambiguation, numbering, or label authoring. Separately, the local host exposes a
platform-independent append-only metadata subset for Title,
Author, Subject, and Keywords on a tightly bounded incremental profile. Sources
may use admitted classic-xref or xref/object-stream forms; the appended revision
uses a classic xref table. It
allocates one fresh Info object, preserves the source as the exact byte prefix
and retains non-target Info entries, then separately reparses the appended
revision and compares Poppler metadata, custom Info, text, page geometry,
signatures, and every-page renders before promotion. Unsupported control streams,
encryption, signatures, reachable XMP, catalog permissions, repair warnings,
and inputs where Poppler detects forms, JavaScript, attachments, or URLs fail
closed. Its shared bounded classic-object planner snapshots arbitrary
non-stream AST values, supports deterministic selected-object updates plus
contiguous named additions with branded pending references, and reparses and
revalidates the exact appended revision. Current callers remain the admitted
metadata, BleedBox, AEC, local-GoTo-link, and named-destination profiles, each with
operation-specific safety rules.
The generic parser accepts bounded identity, ASCIIHex, ASCII85, Flate, RunLength,
or exact ASCII-plus-Flate/RunLength xref streams with bounded
type-2 object-stream members and verifies a classic append. It permits only
absent, null, empty, Flate predictor 1, or bounded PNG predictors 10-15 decode
parameters; RunLength requires exact final EOD and no non-empty parameters.
TIFF, multicolor, sub-byte, and general predictor decoding remain unsupported,
and aggregate intermediate filter work is bounded. A separate
internal compact rewrite preserves stable reachable-object identities and opaque
stream bytes, expands reachable compressed members, and emits one deterministic
closed classic revision without prior revisions, unreachable objects, or control
streams. It rejects reachable signature evidence and is exposed only through
fixed semantic profiles. A separate internal logical-deletion primitive uses opaque
source-bound handles for current ordinary uncompressed objects, requires a
complete valid free list, rejects surviving inbound references and historical
or planned signature evidence, appends deterministic generation-incremented
free rows, and independently verifies the reparsed effective chain. It never
reuses freed numbers and preserves the deleted bodies in the original byte
prefix, so it provides no sanitization, privacy removal, storage reclamation,
secure erasure, or signature-preservation guarantee. No unrestricted product
route exposes it. General filter decoding, unrestricted targeted deletion,
sanitization claims, and unrestricted object discovery remain outside the engine. Historical revisions and old metadata remain recoverable in the shipped append-only profiles, while
general XMP/custom-metadata authoring, sanitization, and arbitrary modern-PDF
support remain outside the bounded `document.metadata-edit` professional
claim. The fixed platform-independent
`local-document-javascript-removal-v1` profile composes logical deletion and
the compact rewrite for one 64 MiB classic-xref document with exactly one
indirect ordinary uncompressed Catalog `/OpenAction` JavaScript action or one
direct Catalog `/Names` dictionary containing one flat `/JavaScript` name-tree
pair. Its action has only `/S /JavaScript` and one non-empty direct string capped
at 64 KiB. Other actions, additional actions, forms, signatures, attachments,
XMP, URLs, tags, layers, shared targets, streams, compressed targets, and
unsupported graphs fail closed. Separate raw reconstruction proves deletion
before the closed rewrite, then proves no prior revisions, unreachable objects,
JavaScript surfaces, or resolvable removed references remain. Poppler page
count, text, boxes, fixed 256-pixel all-page renders, unsigned output, immutable
source, and promoted digest are independently checked. This moves
`security.javascript-controls` from blocked to executable-subset coverage. It
does not promote the planned professional claim or provide execution,
allowlisting, authoring, general action editing, hidden-data sanitization,
secure erasure, or byte/object/signature preservation. A separate platform-independent
`local-document-attachment-removal-v1` profile implements the exact bounded
`document.attachments-manage` claim. It accepts one exact flat
document-level attachment tree in a 64 MiB classic-xref source, with one
unshared Filespec and one direct-length unfiltered embedded stream capped at
8 MiB. Matching name-tree and Filespec names must be 1–240 bytes of printable
ASCII. An optional exact `/PageMode /UseAttachments` hint is removed with the
tree. The host privately extracts attachment 1 and binds its name digest,
content digest, and byte count, while public results omit both the name and
content. Separate logical-deletion and closed-rewrite proof requires the three
attachment objects to become unresolvable and all prior revisions and
attachment surfaces to be absent. Poppler confirms zero output attachments,
unchanged page count, text, boxes, fixed 256-pixel all-page renders, and an
unsigned output before digest-bound promotion. Actions, forms, signatures,
active content, XMP, URLs, tags, shared targets, multiple attachments, and
unsupported graphs fail closed. Attachment addition, user-facing extraction,
rename, and multi-attachment management remain excluded. A separate platform-independent
`local-incremental-goto-link-v1` product path appends one invisible direct
`/Dest [page /Fit]` link between existing pages. It requires explicit integer
MediaBox/CropBox geometry on every page, a source-CropBox-contained integer
rectangle, and an unsigned graph containing only whitelisted passive non-link
annotations and no actions, forms, attachments, XMP, or URLs. The admitted
source may use the bounded classic or xref/object-stream forms above; the
output keeps the exact source prefix and adds a classic revision. Canonical raw
proof plus independent Poppler page/text/box and fixed 256-pixel all-page render
equality precede digest-bound promotion. URI, remote, named, scripted, and
coordinate-controlled destinations, general hyperlink editing, sanitization,
signature preservation, and broader semantic or print equality remain outside
this subset. A separate platform-independent
`local-incremental-named-destination-v1` profile implements the exact bounded
`document.destinations-author` claim. It accepts one 1–64-character ASCII
name matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and one existing page in an
unsigned, unencrypted passive 1–100-page source. It requires an exact empty
Poppler destination inventory, no Catalog `/Names` or legacy `/Dests`, explicit
integer MediaBox/CropBox geometry, and no page annotations. It appends only one
direct Catalog name-tree entry targeting `[page /Fit]`; raw revision proof and
independent Poppler destination, page-count, text, box, fixed 256-pixel all-page
render, unsigned-output, immutable-source, and artifact-digest checks precede
promotion. The name is stored in the output PDF but omitted from public results
and provenance, which retain only its SHA-256. Existing destinations, actions,
forms, signatures, active content, attachments, XMP, URLs, and unsupported
graphs fail closed. General destination editing, removal, lookup, sanitization,
and signature preservation remain excluded. The helper also exposes a macOS-only derived-copy subset for one mutation category per
artifact: four standard metadata fields, one page box, one selected-page
absolute rotation, or one non-action-bearing sticky-note/free-text/square/
circle/highlight annotation. The selected-page CropBox and persistent rotation
paths are the exact-alpha `pages.crop` and `pages.rotate` implementations.
The exact-alpha `pages.page-boxes` command persists one selected CropBox or
BleedBox in a retained source-bound copy. Requests must differ from the current
resolved box and stay within the MediaBox; BleedBox must retain containment of
the unchanged TrimBox. MediaBox, TrimBox, and ArtBox editing, general syntax
preservation, and broad render, semantic, or print equivalence are excluded. The
exact-alpha `pages.insert-blank` command generates one standard 612 by 792 point
text-empty PDF through the local blank-page factory, inserts it after one
selected page, retains a separate source-bound artifact, and independently
checks the ordered page manifest, page count, inserted geometry, empty text,
provenance, and output digest. Arbitrary dimensions and multi-page blank
insertion are excluded. CropBox
Separate exact-alpha authoring jobs cover three passive page-content effects.
`document.backgrounds` applies one opaque solid RGB fill behind existing content
on selected supported pages. `document.bates-numbering` applies passive
identifiers to selected pages of one PDF. `document.watermarks` applies one
bounded printable-ASCII text value in fixed opaque black centered 36-point
Helvetica. Each job stages an immutable source privately, promotes and rereads a
separate artifact, independently reinspects its exact effect and preserved
topology, and revokes failed or cancelled output. Update, removal, transparent,
image, template, document-set, rotated-page, active-content, signed, encrypted,
and broad cross-viewer workflows are excluded.
expansion can reveal previously cropped source content. PDFKit reopens and
checks their requested postconditions; Poppler reparses, page-count checks, and renders every
output page, with fixed 256-pixel-long-edge source/output validation-render
equality required for BleedBox; artifact
promotion requires the validated output digest. This
supports narrower executable-subset records for `document.metadata-edit`,
`review.markup-tools`, and
`review.text-notes-callouts`. A second exact-source profile fills one supported
text/choice AcroForm widget, clears one non-required single-selection choice
only after privately validating its current value and changed render, applies
one on/off transition to a unique unflagged checkbox with a privately validated
two-state appearance, or updates/removes one inert annotation. It rejects
signed, encrypted,
JavaScript/XFA/calculation-bearing, action-bearing, stale, read-only, password,
signature-field, shared, malformed, and unsupported targets, then verifies the
private effect and changed checkbox render after reopen without exposing
values, state names, appearances, or contents. It can also select one exact
source-bound radio widget only when a direct parent owns 2–50 unique reciprocal
kids with unique two-state appearances and consistent private `/V` and `/AS`
state. Reopen must prove the target selected, every sibling off, unchanged
topology/appearance sets, public state agreement, and changed affected-page
renders. Push buttons remain inventory only. On input, direct terminal target topology includes exact,
unique object membership in AcroForm `/Fields`; reopened postflight requires a
unique semantically matching direct field record because PDFKit may rewrite
indirect-object identity. The same bounded raw
catalog/page/annotation/outline/form safety scan are required before mutation
and after reopen. Annotation removal additionally compares a private ordered
raw/public descriptor sequence for every reachable page annotation and permits
exactly the selected page/index descriptor occurrence to disappear, with raw
annotation identity required to be document-global unique. This is the
exact-alpha `sanitize.selective-content` claim without claiming redaction,
hidden-data cleanup, orphan-byte scrubbing, prior-revision removal, or broad
professional sanitization. `forms.source-bound-acroform-fill-save` is therefore the
exact-alpha claim for that separate delivered path. The exact-alpha forms.fill-save
and forms.validate claims are covered by the authenticated local incremental
AcroForm fill/save and read-only validation routes described in the table above.
The
separate `macos-pdfkit-local-goto-v1` profile authors one CropBox-contained
link between existing pages and privately proves identical raw `/Dest` and
exact redundant `/A /GoTo /D` destinations plus the reopened public target.
It accepts no URI, file, named action, script, label, or target coordinate, and
its compact receipt omits the rectangle. Its
`macos-pdfkit-local-goto-remove-v1` sibling revalidates one fully inspected
page/index/fingerprint locator and that same strict dual destination form,
then proves a one-occurrence reachable annotation deletion while preserving
every remaining ordered passive annotation descriptor, page box, and rotation.
The receipt omits the fingerprint and destination, and the operation makes no
hidden-object, prior-revision, or byte/object-preservation claim. Together
these provide a narrow create/remove lifecycle and move `edit.links` from blocked
to executable-subset coverage without promoting its professional claim. The
separate `macos-pdfkit-outline-v1` profile appends one top-level direct
bookmark to an existing page's CropBox top-left. The NFC label is bounded to
1,024 UTF-8 bytes and only its SHA-256 enters the compact receipt. Native
candidate and private-file reopen checks prove the exact direct destination,
unchanged prior direct-destination outline hierarchy, all page boxes and
rotations, and the ordered passive annotation inventory. Existing GoTo-action
outlines fail closed because measured PDFKit serialization normalizes them.
This is the create operation of the exact bounded
`document.bookmarks-author` claim.
The paired `macos-pdfkit-outline-remove-v1` profile consumes one opaque
top-level-index/fingerprint locator emitted only for a complete, non-truncated,
raw-direct `/Dest [page /XYZ x y null]` leaf. Native admission rederives the locator, removes
exactly that node, and requires the remaining outline tree, page boxes,
rotations, ordered passive annotation inventory, per-page text hashes, and
fixed render hashes to match at candidate and private-file reopen. The compact
receipt omits the bookmark title, destination, point, and fingerprint. Nested,
non-leaf, action-based, named, remote, malformed, stale, signed, encrypted,
form-bearing, or active sources fail closed. The sibling
`macos-pdfkit-outline-rename-v1` profile accepts the same opaque leaf locator
plus one changed trimmed NFC label, preserves the direct destination and node
position, and repeats the page geometry, annotation, text, render, and
private-reopen proof. Its receipt includes only the new-label SHA-256, not
either title or the locator. This completes only a narrow create/remove/rename
lifecycle. Page labels, tags, layers, XMP, custom Info keys,
catalog name trees/view preferences, and non-passive page dictionaries are
rejected; bounded standard Info metadata is compared across both reopens. These
three profiles implement only the bounded top-level direct bookmark claim.
The separate fixed line and ink profiles prove the narrowed
`review.drawing-markup` claim. The line profile adds one embedded straight line
between two inspected CropBox-contained points, fixes both ending styles to
`None`, validates exact public and raw geometry plus the annotation-count delta
after reopen, and omits private contents and coordinates from its receipt. The
ink profile adds one embedded open path with 2–32 inspected CropBox-contained
points and privately verifies its public and raw `/InkList` geometry plus the
annotation-count delta without emitting contents or coordinates. Arrows,
polygons, clouds, shapes, styling controls, actions, media, forms, signed or
encrypted inputs, general annotation editing, arbitrary object-serialization
preservation, signature validity, and conformance validation remain excluded.
The cross-platform `local-square-annotation-flatten-v1` profile proves the
narrowed `review.annotation-flatten` professional claim. It accepts only the sole source-bound
annotation occurrence, an indirect printed square with one tiny unfiltered,
resource-free normal appearance on an unrotated page. The raw writer rederives
the existing opaque PDFKit locator, promotes that exact appearance into page
content, deletes the annotation, and compacts the result to one closed classic
revision. Separate raw inspection proves the removed reference is
unresolvable, the appearance bytes and binding are exact, no annotations or
prior revisions remain, and Root/Info/ID policy is preserved. Poppler then
requires unchanged page count, text, boxes, and fixed all-page renders plus an
unsigned output. Multiple annotations, other subtypes, appearance states,
filters/resources/groups, actions, popups, widgets, rotated pages, and general
annotation or form flattening remain unsupported.
Four additional R04 claims use dedicated authenticated local workflows.
`review.file-audio-attachments` embeds one bounded local text, binary, or
validated PCM WAV asset as an inert FileAttachment on one eligible passive PDF
page, excluding Sound, RichMedia, autoplay, and general attachment authoring.
`review.measurements` adds one retained calibrated distance, perimeter, or area
measurement and requires native plus embedded Measure validation.
`review.comments-to-office` exports a source-bound text-only DOCX annotation
and reply summary without Word tracked-comments interoperability.
`forms.javascript-actions` is a privacy-safe inventory of exact inline K, F,
V, and C action loci; it neither returns script text nor authors, mutates,
evaluates, or executes JavaScript.
The local review-exchange authority proves the narrowed `review.shared-review`
claim as one bounded canonical Platen ZIP of source-bound annotation and
comment deltas with atomic idempotent import. It contains no PDF bytes and does
not provide remote sharing or collaboration transport. The separate
`review.notifications-mentions` authority generates and marks read only local
workspace mention records under exact source-digest and revision guards;
email, push, and remote delivery are excluded. The authenticated AcroForm
text-field route proves `forms.static-to-fillable` only as one empty passive
terminal text field in a separately retained source-bound PDF derived from an
eligible form-free passive source. Existing forms, other field types,
signatures, JavaScript, calculations, XFA, and byte or signature preservation
remain excluded.
The authenticated XFDF authority proves `review.annotation-import-export` only
for one canonical Text annotation record imported into an eligible
single-revision classic PDF under exact source-digest and workspace-revision
guards. It retains a separate derived PDF and returns canonical XFDF. FDF,
multiple annotations, other annotation types, indirect annotation arrays,
general XFDF, source mutation, and remote transport remain excluded.
The macOS PDFKit inspection route proves `forms.detect-fields` only as a
bounded read-only per-page inventory of resolved widget identity, type,
control, flag, page-local index, and opaque locator metadata. Values and
private paths are omitted, actions are never executed, and XFA, writing,
validation, calculation, data interchange, submission, flattening, and
signature preservation remain excluded.
The fixed general PDFKit mutation route proves `review.comments` only as one
source-bound sticky Text annotation in a separately retained PDF. PDFKit also
persists its Popup relationship, but threaded replies, collaborative review
state, and general comment authoring remain excluded. The targeted mutation
route proves `review.annotation-properties` only for changing the contents and
bounds of one exact existing FreeText, Square, Circle, or Highlight annotation
identified by page, index, subtype, and source-bound fingerprint. Author,
color, opacity, appearance-stream editing, defaults, and other subtypes remain
excluded.
The separate `edit.object-properties` authority changes only the bounds and RGB
border color of one exact existing inert Square annotation through the same
authenticated source-bound route and a separately retained artifact. Native
reopen, raw three-component `/C` inspection, and descriptor comparison preserve
the target contents, flags, appearance-descriptor shape, and every non-target
annotation descriptor. Every annotation already present in an admitted source
must carry an `/AP` dictionary; pages without annotations remain eligible.
General objects, fills, opacity, blend modes, appearance-stream authoring, and
other annotation subtypes remain excluded.
The authenticated checkbox, radio, and choice routes prove `forms.author` only
for adding exactly one unchecked checkbox, one unchecked bounded radio group,
or one non-combo bounded choice field to an eligible form-free passive source.
Each separately retained artifact is independently reinspected before
promotion. Text, barcode, signature, filling, existing forms, active content,
XFA, encryption, tags, and byte or signature preservation remain excluded.
The private classic-PDF inspection service proves the renamed
`forms.xfa-compatibility` claim only as XFA key-presence reporting on the
Catalog or a direct AcroForm dictionary. It never dereferences the XFA value
and does not read, render, fill, convert, validate, preserve, or claim
compatibility with XFA.
The local review sidecar proves `review.statuses`, `review.filter-sort`,
`review.comment-summary`, and `review.review-tracking` only against retained
session records bound to one immutable source digest and workspace revision.
It updates one existing annotation status, filters or sorts bounded local
annotations, returns a text-only local comment rollup, and inspects retained
local activity records. It does not read or mutate PDF annotations, provide
remote or multi-user collaboration, manage participants, assignments, due
dates, or outstanding work, or produce PDF, CSV, XML, or print reports.
Three fixed PDFKit annotation profiles narrow the remaining general review
claims. `review.markup-tools` creates one inert Highlight annotation at an
explicit page rectangle. `review.text-markup` creates one inert Underline
annotation at an explicit page rectangle. `review.text-notes-callouts` creates
one inert FreeText box at an explicit page rectangle. Each result is a separate
source-bound derived PDF that is reopened and independently inspected. Text
selection and QuadPoints targeting, drawing, stamps, sticky notes, callout
leaders, strikeout, squiggly, insert or replace semantics, styling controls,
replies, collaboration, signed, encrypted, form-bearing, or active inputs, and
source mutation remain excluded.
The fixed protection profile is the one exception promoted to professional
delivery: it meets the narrow `security.open-password` promise by creating a
validated password-required copy, not by offering a full encryption suite. It
is capped at 100 pages/128 MiB; rejects encrypted, tagged, form, JavaScript,
signed, attachment-bearing, and URL-bearing inputs; uses only AES-128/R4/V4/AESV2
and four closed advisory profiles. Credentials cross token-authenticated
same-origin loopback HTTP as bounded JSON and then bounded private stdin; they
are not intentionally retained in app state, files, results, provenance, argv,
or application logs, with developer-tool, instrumentation, and transient-memory
residuals disclosed. Its immutable source and validated
derived-output digest remain bound through promotion. Arbitrary permissions,
selectable AES/AES-256, recovery, and certificate encryption remain planned or
blocked. A distinct `security.remove-protection` executable subset accepts only
the exact current-session retained artifacts created by that fixed boundary.
It requires a provenance/profile/digest/page-count match and technical PDFKit
owner authorization before any page copy, produces a fresh document, privately
proves stable visible/passive structure after no-password reopen, and passes
independent final-trailer, Poppler, all-page-render, and digest checks. The host
cleartext artifact is consumed after one transfer; the protected artifact and
immutable source remain. This does not promote the professional claim because
recovery/cracking/bypass, arbitrary decryption, secure erasure,
legal-ownership proof, signature-safe rewriting, sanitization, redaction, and
byte/object preservation remain unavailable. A strict local CLI adds manifested sequential batch OCR,
stability-gated watch OCR, and named no-clobber prepress artifact operations;
the prototype ledger records 24 sidecar and one proposal surfaces across the
bounded workflows. A separate
durable automation executable subset stages private digest-bound sources and
persists an exact versioned allowlist/limits policy plus bounded jobs with
single-owner locking, idempotency, renewable leases, signal cancellation,
restart recovery, fixed classified retry, and receipts. CLI submit, one-shot
run, status, and pending-cancel commands consume only the fixed
`automation_inspect_v1` operation. It has no HTTP route, scheduler, action
sequence, script evaluator, general executor, retention/purge workflow, active
cross-process cancellation, or automatic stale-lock deletion, so the
professional automation capability remains planned. A
canonical digest-bound project bundle also exports and restores their complete
revisioned workspace for an identical source PDF. These stay
separate from professional delivery whenever they omit required PDF-object
semantics, conformance, remote systems, or irreversible-output evidence.

The separate `sanitize.metadata` executable subset uses the fixed
`macos-pdfkit-metadata-sanitize-v1` profile. It accepts only a strict passive,
unsigned, unencrypted, untagged, form-free source with no attachments, external
URLs, layers, or unsupported catalog/page/name-tree structure. A fresh PDFKit
copy removes document Info, custom Info, and catalog XMP; native reopen checks
require an empty Info dictionary, no XMP, and matching page boxes, rotations,
ordered passive annotations, bounded local outlines, text hashes, and render
hashes. Independent Poppler postflight confirms standard/custom/XMP metadata
absence, unsigned passive output, unchanged page count, and a render for every
page before digest-bound promotion. It does not claim hidden-data cleanup,
orphan-object or prior-revision scrubbing, secure erasure, signature
preservation, or byte preservation. This fixed source-bound behavior is the
implemented `sanitize.metadata` claim; broader hidden-data cleanup remains
separate.

The trusted AEC bridge separately binds scale calibrations,
distance/perimeter/area/count calculations, quantity takeoffs, markup lists,
manually authored sheet metadata, bounded spaces and regions, and local revision
status records to the immutable source digest and workspace revision. Geometry
produced by the measurement bridge additionally binds the page and unrotated
CropBox. On macOS it can materialize
one selected measurement as a separately validated inert PDFKit line, ink, or
circle annotation. Calibrated geometry receives a bounded append-only ISO/PDF
`/Measure` scale on the page viewport, with line-level `/Measure` plus
`/IT /LineDimension` for a two-point distance; count remains explicitly
uncalibrated. A self-contained portable bundle embeds the exact source PDF and
an integrity-checked workspace snapshot for authenticated manual local transfer;
import starts a fresh local revision and appends a replace audit event. The takeoff path groups
1–100 unique current measurements by SI unit with deterministic provenance; it
does not price, collaborate, or mutate the PDF. The custom-column path evaluates
one manually authored safe arithmetic expression over an exact bounded numeric
row without mutating the workspace. The affine page-coordinate path stores one
manually authored bounded local calibration and converts one bounded point; it
does not interpret GeoPDF or CRS metadata, perform geodesy, or establish
coordinate-system authority. The markup inventory creates and lists local
records with bounded type, status, and page
filters; it does not inspect or mutate PDF annotations. Source-bound markup
toolsets retain a bounded tool registry, revision overlay records retain only
distinct source digest descriptors, and slip-sheet records retain bounded
source-bound plans. These records do not create markup, render or align
overlays, replace pages, carry forward markup data, mutate PDFs, or connect to
remote collaboration. Spaces and regions store
declared-page PDF-point polygons with deterministic six-decimal area and
perimeter, without page-box inspection or PDF output. Revision status records
permit only draft to issued to superseded and survive portable local project
transfer. This remains a bounded AEC subset, not a multi-document drawing set,
network collaboration system, or synchronized review system.

## Requested advanced skeletons

| Skeleton | Catalog records | Runnable subset records | Other records |
| --- | ---: | ---: | ---: |
| OCR | 14 | 6 | 8 |
| Signing | 13 | 3 | 10 |
| Redaction | 11 | 11 | 0 |
| Accessibility remediation | 15 | 15 | 0 |
| AI research map | 15 | 0 | 15 |
| AEC | 18 | 15 | 3 |
| Prepress | 26 | 13 | 13 |

The OCR skeleton stays non-executable. Two records are exact-alpha, three are
executable subsets, one is service-only, and eight are blocked. Table output is
review-required, not authoritative recognition. The signing skeleton now has
three exact-alpha records and ten blocked records. `sign.validate-certificate` retains the
independent offline Poppler integrity/coverage subset, run with a job-private
host-owned NSS directory and fixed `-nocert`/`-no-ocsp` arguments. It returns
strict no-raw/no-path evidence for embedded-signature cryptographic integrity
and full versus prior-revision coverage. Only after Poppler reports valid
integrity, a second fixed pass streams each CMS through an exact pre-created
FIFO inventory in a mode-`0500` private directory. Host readers retain at most
1 MiB each and 8 MiB total, aborting on the first excess byte while FIFO
backpressure prevents regular-file growth. Only a successful bounded receipt is
promoted for descriptor/digest postflight. The excluded direct PDF strings are
also descriptor-read as defense in depth. On macOS, an optional digest-pinned native
Foundation/Security/CryptoKit helper accepts bounded DER or BER, verifies that
exact detached CMS against the ranges, and then evaluates its certificate path
with `SecPolicyCreateBasicX509` against the current Mac trust configuration at
one host-current time; certificate fetching is disabled and verified.
Unsupported subfilters, malformed CMS/BER, signature mismatches, and bounded-resource cases fail closed.
Poppler's result remains explicitly engine-scoped; the combined conclusion is
indeterminate unless every exact-CMS prerequisite completes, and the UI shows
negative records first with an omitted-record count.
This does not establish trusted-signer identity, PDF-signing key usage, signing-time validity, revocation,
OCSP/CRL/LTV, trusted timestamps, DocMDP/certification permissions, legal
effect, or signing. Unsandboxed native parsing remains a residual risk. The
redaction skeleton likewise remains bounded: ten records are exact-alpha and
one is an executable subset. The existing
`verified-raster-burn-v2` path binds declared source text
transiently to an unrotated target region or the entire selected page whose
CropBox matches its MediaBox; opaque-black target pixels and exact non-target
equality are verified; and output must be passive, unsigned, textless,
attachment-free, and object-URL-free. It is destructive image-only output, not
object-level sanitization. A separate source-bound plan bridge stores reviewed
geometry as a `proposed-not-applied` sidecar: host-derived page geometry and
normalized region text become source/page/geometry-bound per-process HMAC
evidence, while plaintext text, excerpts, and the key are neither retained nor
returned. Its application request contains source digest and workspace revision
plus only plan/mark IDs and plan digest; a workspace read lease, strict
current-schema check (including legacy-plan rejection), source/page recheck,
and digest binding gate the transient handoff to `verified-raster-burn-v2`.
The preview remains proposed-not-applied and geometry-only. Application creates
a separate derived artifact, and neither the immutable source nor proposal
changes. Rotated pages, CropBox/MediaBox differences,
object-level removal, hidden-data/prior-revision cleanup, and signature
preservation remain unsupported. Separately, one exact source-bound inert
annotation can be removed only when the reopened ordered reachable annotation
graph equals the source snapshot minus that target; unreachable bytes and
broader hidden data are not claimed removed. The metadata-only subset removes
document Info, custom Info, and catalog XMP from a separately verified fresh
copy while rejecting unsupported document graphs; it is not broad hidden-data
sanitization or secure erasure. The prepress skeleton also remains
disabled while thirteen built-in subsets cover fixed profiles and reports, font
and image checks, output preview, separations, ink coverage, simulated
overprint, transparency flattening, exact-profile CMYK-targeted normalization,
fixed OutputIntent assignment, passive bleed/crop marks, and fixed 2-up/4-up
N-up. Derived PDFs are source/profile-digest-bound,
reparsed, geometry/text checked, fully rendered, and promoted only with the
validated output digest. Existing DeviceCMYK is not retargeted,
Separation/DeviceN is retained, no OutputIntent is assigned, imposition printer
marks fail closed, and production/PDF/X certification is not claimed.
All seven templates still describe the complete future extension surface. AI
remains research-only and is excluded from the local implementation roadmap.

The accessibility-remediation skeleton likewise stays non-executable. Its
ledger has thirteen exact-alpha records, two executable subsets, no sidecar,
proposal, or service-only record. Its fixed built-in review, report
export, bounded heading/list heuristics, Artifact-role inventory,
ToUnicode/embedding evidence, and human-authored alt-text proposal are
source-bound exact-alpha records; all remain bounded review or proposal
surfaces. Auto-tagging and color-contrast remain executable subsets; tagged-PDF
remediation and existing-structure reading-order repair are exact-alpha,
source-bound retained-artifact workflows.
A fail-closed fixed-profile veraPDF 1.30.1
loader, parser, authenticated route, client, and GUI state now exist for PDF/A
and PDF/UA, but no transitively pinned bundle or native conformance-corpus
fixture is shipped; those professional claims therefore remain blocked. PDF/X
still has no authoritative engine.

Nine plugin-platform records now have host-only service implementation evidence:
signed installation and verification, registry inventory, exact dependency and
version checks, scoped permissions, framed RPC, one-shot lifecycle cleanup,
and controlled rollback. Manifest v3 plus a concrete native supervisor adapter
also bind an exact classic-script entry to a signed release policy, strict
static/live macOS identity checks, private two-phase pipes, bounded output/RPC,
activation quarantine, and process-group cleanup. The false broad claims remain
blocked in the prototype ledger because no production-signed package can
execute. The
macOS Seatbelt behavior probe observes
fixed network, write, sensitive-read, and process-fork canary denials on the current OS, but
its allow-default experimental profile reports `osSandbox: false`; CPU and hard
memory ceilings are also absent. The unsigned SwiftPM native pair is rejected,
and the current host reports `hardMemoryQuota: false` because a meaningful
`RLIMIT_AS` returns `EINVAL`; the concrete adapter closes that process before
issuing grants or handles. `platform.plugins.runtime-sandbox` therefore remains
blocked.

The GUI now consumes a host-derived, one-shot-per-session diagnostic status via
an authenticated same-origin POST. It visibly reports 0/5 production hard
controls and lists best-effort canaries independently; even an 8/8 diagnostic
result remains blocked and states that no plugin code ran. This is evidence for
the existing sandbox-probe prototype only. The professional claim is planned
and the prototype tier of `platform.plugins.runtime-sandbox` is blocked.

## Material missing areas

The remaining professional claims include general structure-preserving PDF
content editing, complete embedded annotation/form workflows, secure signing
and key custody, encryption
administration, object-level redaction and sanitization, tagged-PDF
accessibility remediation, staged-and-corpus-verified standards validation,
authoritative production preflight/print,
remote collaboration/DMS, durable automation beyond the bounded CLI/watch
subset, complete native AEC/project workflows, rich
media/3D/portfolios, integrations, administration, and a securely executable
third-party plugin platform.

High-risk features stay planned until their output validators exist. Examples:

- object-level redaction still needs absence checks across content streams,
  metadata, layers, and prior revisions beyond the verified destructive raster
  output; and
- remaining signing claims still need correct ByteRange/CMS construction,
  host-owned key handling, identity, timestamps, and revocation/LTV;
- accessibility needs deterministic tag-tree, reading-order, table, form, and
  PDF/UA evidence; and
- prepress needs authoritative standards validators, OutputIntent authoring and
  fixtures, existing-CMYK retargeting, production separations/ink/trapping and
  printer-mark evidence, full imposition, and constrained object-level fixups
  beyond the current review and fixed N-up subsets.

## Delivery rule

Promote a planned record only after the runtime behavior, unavailable/error
states, trust boundary, integrity checks, and deterministic fixture tests all
exist. A discovered executable or a visible button is not implementation
evidence. Browser-native behavior must also be visibly tested on each supported
browser rather than generalized from source inspection.
