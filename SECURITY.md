# Security policy and threat model

## Reporting

Use GitHub private vulnerability reporting from the repository Security tab
when it is available. Include the affected revision, a minimal safe
reproduction, impact, and mitigation ideas. If private reporting is not
available, open a public issue containing only a request for private contact.

Do not place private PDFs, extracted text, credentials, certificates, private
keys, internal paths, or sensitive reproductions in a public issue. Do not send
secrets until a private channel and intended recipient have been confirmed.

## Current boundary

Platen has three local trust zones:

1. the browser holds the selected `File`, Blob preview URLs, UI state, and a
   per-process API token; and
2. a Node host bound to `127.0.0.1` stores immutable private copies and invokes
   fixed trusted Poppler, Tesseract, Ghostscript, ImageMagick, and LibreOffice
   adapters for explicitly allowlisted operations. On macOS it may also stage
   a fixed release-built Apple PDFKit inventory, bounded derived-mutation,
   fixed AES-128 password-protection, and fixed metadata-sanitization helper
   into the private session;
   and
3. an explicitly invoked local CLI has caller-selected input/output path
   authority, but native engines still receive only private store/workspace
   paths.

There is no document egress, telemetry, cloud service, credential flow, CORS,
or executable third-party plugin path.

## Controls

- Exact `Host` validation and a random 256-bit token protect all data routes.
- State-changing requests also require a same-origin HTTP `Origin`, explicit
  method, and non-simple media type.
- Uploads stream to private mode-`0700` session directories and mode-`0600`
  files with size limits, PDF-header validation, SHA-256 recording, fsync, and
  atomic promotion.
- GUI requests use opaque IDs and never supply paths, executable names, flags,
  environment variables, or output templates.
- Local project bundles are canonical UTF-8 JSON capped at 600 KiB. They omit
  the session document ID, carry a payload digest and source-PDF digest, reject
  unknown fields and noncanonical encodings, and import only with an exact
  expected workspace revision into byte-identical source content. The payload
  digest detects unintentional or unrecomputed modification; it is not a
  publisher signature or proof of authorship.
- OCR table CSV export neutralizes formula-leading cell values before
  spreadsheet import. The table grid remains heuristic OCR evidence and
  requires human review; it is not authoritative table recognition.
- OCR user dictionaries accept at most 256 trimmed NFC terms under fixed
  per-term and aggregate bounds. Control/format characters, unpaired
  surrogates, duplicates, and leading path-like values fail closed. The host
  creates the canonical newline-delimited file exclusively at mode `0600`
  inside the job workspace and passes only that internally constructed path to
  Tesseract. Results and provenance disclose only term count and SHA-256; job
  cleanup removes the words file. Browser-held input remains visible to the
  current browser session until the user clears or replaces it.
- OCR suspect review snapshots at most 500 already validated low-confidence
  words and three fixed human decisions, then exports at most 4 MiB of canonical
  JSON bound to the source and OCR artifact digests. Suspect text is included by
  design. No correction, PDF mutation, OCR-artifact mutation, source-page box
  alignment, or authoritative-text claim is made.
- The GUI publishes a searchable OCR artifact only after matching its document
  and source binding and recomputing the exact Blob SHA-256. This contiguous
  browser verification is capped at 64 MiB; larger ephemeral artifacts are
  deleted before retrieval and are not exposed as reviewable GUI results.
- CLI inputs are opened through a no-follow descriptor, matched to their
  pre-open inode, copied to the private store, and checked for changes during
  ingestion. Outputs use mode-`0600` same-directory partials plus a no-replace
  hard-link publication step. There is no force/overwrite, recursion, glob,
  arbitrary engine, environment, temp-root, or concurrency option.
- The durable automation lane accepts only the built-in
  `automation_inspect_v1` operation. Submission runs under an application-scoped
  transaction lock, descriptor-copies and digest-binds one ephemeral store
  document into an existing private automation root, then durably enqueues only
  the opaque source ID and digest. The queue persists its exact allowlist and
  limits in a canonical version-1 journal. One private ownership lock permits
  one cooperating runtime per root; general inspection redacts active lease
  tokens; journal state is validated before every replacement; and workers
  renew leases while fixed Poppler inspection runs. The invoking OS user and
  access to the private root are the authority. There is no HTTP automation
  route or independent automation token. Active work is cancelled through the
  owning process's signal; the separate cancel command can cancel pending work
  only when it can acquire the root. Graceful close removes the lock. A crash
  leaves it fail-closed and requires trusted administrative recovery after
  confirming the prior process is gone. The default 256-job journal and the
  source store's 256-record, 512-MiB-per-source, 2-GiB aggregate limits are
  finite; no automatic retention or purge exists. It is not a scheduler,
  scripting interface, action-sequence engine, or arbitrary executor.
- Local release validation reads only a fixed safe required-file policy through
  no-follow leaf descriptors and compares file plus root/ancestor identities
  around each read. The policy inventories every JavaScript and native Swift source module and
  separately proves reachability from the browser, host, and CLI entrypoints;
  disconnected plugin foundations remain exact, reviewed, non-executable
  classifications. Run it against a trusted, quiescent checkout. Node does not
  expose fully pinned `openat`-style traversal here, so a hostile same-user
  ancestor swap can cause a read before postflight rejects the receipt. The
  receipt includes a deterministic local source-inventory SBOM, while signing,
  notarization, retained candidate attestation, publication, and distribution
  trust remain outside it. Its `distributionStatus` is always `not-ready`.
- Engine adapters resolve fixed absolute executables, use argument arrays with
  `shell: false`, set a minimal environment, reject extreme page geometry, use
  explicit raster pixel boxes, and bound time, output, active children, and
  queued work. Killed children retain or quarantine their runner slot until
  closure is known; total slot quarantine fails further work until restart.
- Sources are never overwritten. Derived PDFs are separately validated,
  parsed for expected page counts, digested, named, and downloaded. Promotion
  requires the validated output SHA-256, verifies provenance against the owning
  immutable source digest, rehashes the descriptor-copied bytes, and rolls back
  on digest mismatch or cancellation. OCR text is re-extracted when recognition
  reported words.
- The platform-independent incremental-metadata route accepts one exact
  lowercase source digest and four trimmed, NFC, 1,024-byte standard Info
  fields. Its synchronous raw parser is capped at 31 source revisions,
  50,000 aggregate xref rows, 100,000 aggregate AST nodes, and 8 MiB
  of aggregate decoded strings/names, accepts only direct stream lengths, and
  proves revision chronology plus non-overlapping top-level object and
  xref/trailer spans. It accepts only the bounded classic or admitted
  xref/object-stream controls described below and rejects encryption, unsupported
  hybrid/control forms, catalog permissions, reachable XMP metadata, malformed or repair-warning
  inputs, signatures, and Poppler-detected forms, JavaScript, attachments, or
  URLs. Output must retain the source as its exact prefix, append one canonical
  fresh Info object/revision, preserve non-target Info and the catalog root,
  and pass separate raw reinspection plus independent metadata, content, every-page render, source/file
  identity, and artifact-digest checks. Previous metadata bytes intentionally
  remain recoverable; this boundary is editing, not sanitization or broader
  active-content proof.
- The shared classic-object transaction layer snapshots only own data
  properties, rejects accessors, symbols, cycles, sparse arrays, numeric token
  mismatches, dangling or forged pending references, excessive depth/items,
  expanded alias byte amplification, and excessive aggregate appended bodies.
  It allocates new objects contiguously from the parsed effective `Size`, emits
  one append-only revision, and reparses and revalidates every nested reference
  in the exact output. It also accepts opaque direct-length stream additions or
  replacements: caller bytes are privately copied, SHA-256-bound, included in
  the 1 MiB aggregate append limit, framed without text conversion, and checked
  byte-for-byte after reparse while `/Length` is canonicalized. A separate
  generic path accepts identity, one ASCIIHex, ASCII85, Flate, or RunLength filter,
  or an exact ASCII-plus-Flate/RunLength chain for xref streams and bounded type-2
  object-stream members. Decode parameters are limited to absent, null, empty,
  or Flate predictor 1 and bounded PNG predictors 10-15; RunLength requires an exact
  final EOD marker and absent/null/empty parameters. TIFF, multicolor, sub-byte,
  and general predictor decoding remain unsupported. It caps each encoded control at 2 MiB and their aggregate
  at 8 MiB, validates exact `/W` and `/Index` row framing, rejects trailing
  compressed bytes, proves every physical header and control self row, blocks
  control-object updates, and emits a classic append whose `/Prev` targets the
  xref-stream revision. Each admitted object stream has at most 10,000 exact
  non-stream members and 2 MiB encoded bytes, and shares 256-version, 8 MiB
  encoded/decoded, and 16 MiB per-scope filter-work aggregate limits.
  Member directories, slices, same-revision container authority, exact repeated
  rows, and uncompressed shadowing are checked; recompression, orphan members,
  container reuse, top-level bare-reference members, and control-object authoring
  or updates fail closed. Parsed structures are branded; resolvers consult
  private authority maps and return defensive AST copies, so mutations to exposed
  maps or prior results cannot forge resolution. The builder also validates the
  effective non-stream Catalog and Info roles before returning append bytes.
  A separate bounded compact rewrite digest-binds a synchronous non-shared
  source buffer and reparses it,
  traverses only effective Root and optional Info references, preserves stable
  object identities and opaque stream bytes, and emits a deterministic single
  classic-xref revision. Its independent proof requires closed output with no
  prior revision, unreachable live object, object-stream container, xref-stream
  control, or non-whitespace residue. Existing ID pairs are preserved. Reachable
  signature dictionaries, signature fields, byte ranges, and control objects are
  rejected. The rewrite is capped at a 512 MiB source, 10,000 reachable objects,
  and 256 MiB of output, and it is not a sanitization or signature-preserving boundary.
  A separate internal logical-deletion path requires opaque handles bound to the
  exact parsed source and a complete, acyclic, in-range effective free list. It
  permits only current ordinary uncompressed objects through generation 65534;
  Root, Info, controls, compressed entries, duplicate targets, update collisions,
  surviving inbound references by object number, and historical or planned
  signature evidence fail closed. Targets are sorted into a deterministic
  object-zero-led chain, their generations are incremented, and a branded
  verifier rebuilds and reparses the exact append before checking every xref row,
  effective entry, free-chain link, written object, and now-unresolvable target.
  Old bodies and revisions remain byte-for-byte in the source prefix, additions
  never reuse freed numbers, and this is not sanitization, privacy removal,
  secure erasure, storage reclamation, or signature preservation.
  The metadata, BleedBox, AEC, local-GoTo-link, and named-destination writers use the generic parser while retaining
  classic appended revisions and their operation-specific admission rules; strict
  classic compatibility exports remain for classic-only callers. General stream decoding/filter semantics, encryption, repair,
  unrestricted targeted deletion, profile-independent sanitization, and profile-independent
  admission or semantic validation remain outside this boundary.
- The platform-independent JavaScript-removal route accepts only an exact
  lowercase source digest and the fixed
  `local-document-javascript-removal-v1` profile. The source is capped at
  64 MiB and must use classic xref tables with a complete valid free list. It
  admits exactly one indirect ordinary uncompressed Catalog `/OpenAction`
  JavaScript action or one direct Catalog `/Names` dictionary pointing to a
  flat one-pair `/JavaScript` name tree. The action must contain only a direct
  non-empty script string capped at 64 KiB. Other actions, `/AA`, `/Next`,
  forms, signatures, attachments, XMP, URLs, tags, layers, streams, compressed
  or shared targets, and unsupported graphs fail closed. The writer replaces
  the Catalog entry, proves generation-incremented logical deletion, then
  compacts only the reachable Root and optional Info graph into one closed
  classic revision. Separate raw rebuilding and reinspection require the
  removed references to be unresolvable and prior revisions, unreachable
  objects, control streams, and JavaScript surfaces to be absent. Poppler must
  report matching page count, text, and boxes, byte-identical fixed 256-pixel
  all-page validation renders, no output JavaScript, and an unsigned output.
  Private file identity, immutable-source digest, promotion digest, cancellation,
  and synchronous rollback checks also apply. Cleanup after a later HTTP response
  disconnect is best-effort because the response event cannot carry an awaited
  failure; an orphan remains private and is removed with its document or local
  host session. This removes only the admitted locus and its
  historical bytes; it is not a general active-content scanner, action editor,
  hidden-data sanitizer, secure-erasure mechanism, or byte/object/signature-
  preservation boundary.
- The platform-independent attachment-removal route accepts only an exact
  lowercase source digest and the fixed
  `local-document-attachment-removal-v1` profile. The source is capped at
  64 MiB and must contain one exact flat document-level embedded-file name
  tree, one unshared Filespec, and one direct-length unfiltered stream capped
  at 8 MiB. The matching name-tree and Filespec names must be 1–240 bytes of
  printable ASCII. An optional exact `/PageMode /UseAttachments` hint is removed.
  Poppler attachment 1 is extracted only into the mode-`0700` job workspace.
  The host rejects links, non-regular files, multiple links, zero or oversized
  files, warning output, and identity changes; opens with no-follow semantics;
  forces mode `0600`; and hashes one exact bounded read without returning its
  bytes. Logical-deletion and closed-rewrite verifiers require the three
  attachment objects to become unresolvable and all prior revisions and
  attachment surfaces to disappear. Poppler must then report zero attachments,
  unchanged page count, text, boxes, byte-identical fixed 256-pixel all-page
  validation renders, and unsigned output. Public results and provenance retain
  only name and content SHA-256 values and the content byte count. Actions,
  forms, signatures, active content, XMP, URLs, tags, shared targets, multiple
  attachments, and unsupported graphs fail closed. This is not attachment
  addition, user-facing extraction, rename, multi-attachment management,
  signature preservation, or general hidden-data sanitization.
- The platform-independent copy-page route accepts only the fixed
  `local-copy-one-page-between-documents-v1` profile, exact lowercase SHA-256
  bindings for two distinct immutable documents, one secondary page from 1
  through 100, and one primary insertion position from 0 through 100. Both
  sources are descriptor-copied into a private mode-`0400` workspace. Before
  `pdfseparate` or `pdfunite`, a bounded dependency-free parser checks classic,
  xref-stream, and object-stream inputs, caps revisions and page-tree depth and
  nodes, requires parent and `/Count` consistency with Poppler, and rejects
  catalog-level structures, outlines, optional content, annotations, and
  actions, including nested and historical records. Poppler independently
  rejects encrypted, form-bearing, JavaScript-bearing, tagged, XMP-bearing,
  attachment-bearing, URL-bearing, or signed sources. Promotion requires the
  exact requested page order to match source page boxes and rotation, NFC text
  hashes, and fixed 256-pixel render hashes. Public provenance retains only
  input IDs/digests, numeric selections, page count, the aggregate manifest
  digest, and validator names. Source paths, text, page-level hashes, and render
  bytes are not retained. This profile does not preserve document-level
  structures, signatures, indirect-object identity, or original bytes.
- The platform-independent named-destination route accepts only an exact
  lowercase source digest and the fixed
  `local-incremental-named-destination-v1` profile with one existing page and
  one 1–64-character ASCII name matching
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. It requires an unsigned, unencrypted,
  passive 1–100-page source, an exact empty Poppler destination inventory, no
  Catalog `/Names` or legacy `/Dests`, explicit integer MediaBox and CropBox
  arrays, and no page annotations. Actions, forms, signatures, active content,
  attachments, XMP, URLs, and unsupported graphs fail closed. The writer
  updates only the Catalog with one direct `/Names /Dests /Names [(name) [page
  /Fit]]` entry in a classic append, preserving the source as the exact prefix.
  Canonical raw proof binds the Root row, unchanged effective entries,
  Root/Info/ID policy, target reference, name SHA-256, and appended revision.
  Private staging and repeated source identity checks surround independent
  Poppler destination, page-count, text, box, fixed 256-pixel all-page render,
  unsigned-output, and artifact-digest validation. The name is intentionally
  present in the output PDF but omitted from public results and provenance,
  which retain only its SHA-256. Historical bytes remain, so this is not
  general destination management, sanitization, privacy removal, secure
  erasure, or signature preservation.
- The separate `local-incremental-goto-link-v1` route accepts exactly an
  existing source page, existing target page, and integer rectangle. Every leaf
  page must have explicit integer MediaBox and CropBox arrays, with each CropBox
  contained by its MediaBox and the requested rectangle contained by the source
  CropBox. Existing annotations must belong to a fixed passive whitelist and
  cannot carry links, actions, files, appearances, or related-object graphs.
  The writer appends one invisible direct `/Dest [page /Fit]` link and no `/A`
  dictionary, while catalog/page actions, all standard action families,
  signatures, forms, attachments, XMP, URLs, and active annotation surfaces
  fail closed. Canonical raw proof accounts for the two changed/new objects,
  unchanged effective xref rows including compressed provenance, Root/Info/ID
  policy, exact source prefix, and classic appended revision. Private staging,
  repeated file-identity and source-digest checks, independent Poppler page,
  text, box, and fixed 256-pixel all-page render equality, unsigned-output
  inspection, rollback, and digest-bound promotion apply. Prior revisions and
  orphan bytes remain, so the profile does not sanitize, preserve signatures,
  provide general hyperlinks, or prove broader semantic or print equivalence.
- Private job workspaces have a recursive monitored 512 MB/1,024-file quota and
  reject links, devices, multi-link files, and excessive nesting. Native OCR
  outputs and promoted artifacts are read/copied through no-follow single-link
  file descriptors. OCR rasters, TSV/ALTO review data, and page-composition parts are removed after their final
  consumer rather than accumulating for the entire job.
- Batch OCR is sequential and bounded to eight files/50 pages and aggregate
  input/output ceilings. Watch OCR scans direct children only, requires stable
  repeated metadata, rejects PDF symlinks, never deletes inputs, caps each
  session, and records manifests plus per-attempt events.
- Fixed preflight-review profiles consume only bounded, normalized Poppler
  evidence. Reports contain source digests and resource summaries rather than
  host paths or raw native output, distinguish unknown checks from failures,
  apply no fixups, and carry an explicit non-authoritative limitation.
- The authenticated accessibility route accepts only the fixed
  `basic-local-review`, binds normalized Poppler evidence to the immutable
  source digest, caps review at 200 pages and 50,000 tag records, preserves
  unknown ancestry as coverage-unknown, and never returns page text or host
  paths. Optional PDFKit permission evidence may pass or fail only after its
  staged-helper integrity checks; trust, workspace, parser, and page-count
  failures propagate. Link purpose, reading order, alternative text, form
  semantics, artifacts, contrast, and PDF/UA conformance remain unproven.
  Remediation creation recomputes the trusted review, requires the exact source
  digest, report digest, and workspace revision, accepts only current report
  candidates, and atomically stores one canonical proposal sidecar. Proposals
  are exported only by server-generated ID and never mutate PDF bytes or tags.
  An image-alt-text proposal requires exactly one current opaque image locator
  and bounded trimmed NFC human-authored text; missing/unknown/duplicate
  targets, control or format characters, and unpaired surrogates fail closed.
  Leading path-like text is rejected by the same workspace leak-prevention
  policy used for every local sidecar entity.
  No image bytes enter the proposal service, and it neither infers text nor
  claims that the authored meaning is correct.
- The optional PDFKit routes accept one fixed inspection profile, five fixed
  derived-mutation profiles, and one fixed password-protection profile; none
  accept caller paths, limits, flags, environment, or
  query parameters. Mutation JSON is capped at 8 KiB, bound to the lowercase
  immutable source SHA-256, and contains exactly one category: four standard
  metadata fields, one page box, one selected-page absolute 0/90/180/270-degree
  rotation, or one non-action-bearing sticky-note/free-text/square/circle/
  highlight annotation, or one source-bound text/choice form
  fill, privately verified non-required single-choice clear, privately resolved
  checkbox on/off transition, inert annotation update/removal, or one
  CropBox-contained local GoTo link between existing pages, or one inert
  straight line between distinct CropBox-contained points, or one open ink
  path containing 2–32 CropBox-contained points. Line and ink contents and
  coordinates stay out of their compact receipts; candidate and reopened checks
  require the exact geometry, fixed `None`/`None` line endings, annotation-count
  delta, raw `/InkList` for ink, and hardened inert content graph. `/Popup` and
  `/Parent` relationships must form direct reciprocal inert pairs within the
  same page `/Annots` array; hidden, orphaned, cyclic, or active related objects
  fail closed. The selected-page CropBox and BleedBox categories reject signed,
  no-op, and out-of-MediaBox requests; BleedBox must also retain containment of
  the unchanged TrimBox. Candidate/reopen plus independent Poppler evidence
  prove the requested resolved box while preserving every unrelated page box and
  rotation plus a private bounded descriptor of annotation subtype, geometry,
  flags, contents digest, and action/destination/relationship/appearance shape.
  BleedBox also requires one fixed 256-pixel-long-edge Poppler validation
  render of every source/output page to match byte-for-byte. This bounded check
  does not prove equality at other resolutions or in other renderers;
  explicit-versus-inherited box syntax is not preserved.
  Expanding a CropBox can reveal source content that
  was previously cropped from view. The local-link
  profile rejects signed, encrypted, form-bearing, JavaScript-bearing, and
  action-bearing sources. Existing annotations must use an explicit inert
  subtype allowlist and contain no associated-file, file-specification,
  multimedia, 3D, RichMedia, or external-data payload keys; FileAttachment,
  Sound, Movie, Screen, RichMedia, 3D, Projection, automatic page-presentation,
  and page-associated-file inputs fail closed. Reopened raw postflight repeats
  those checks and permits only the newly added
  annotation's exact `/A << /S /GoTo /D ... >>`, requires its `/D` to resolve
  identically to `/Dest`, and rejects URI, remote-file, named, launch, submit,
  JavaScript, and additional actions. Targeted
  operations reject signed, encrypted/locked,
  JavaScript/XFA/calculation-bearing, stale-locator, action-bearing,
  signature-field, read-only, password, shared, malformed, and unsupported
  targets. A bounded raw scan runs before mutation and after reopen, rejecting
  catalog permissions, page/annotation/outline actions, non-destination name
  trees, active AcroForm field trees, and parent/kid widget inheritance;
  legacy categories require no form. Each input form target must occur exactly
  once as the identical page-widget object in the direct AcroForm `/Fields`
  array. Because PDFKit can rewrite indirect-object identity, reopened
  postflight accepts only one semantically matching direct field record whose
  `/FT`, `/T`, `/Ff`, `/V`, `/AS`, and `/AP` presence agree with the reopened
  page widget. Orphan, duplicate, parent-owned, and ambiguous membership fails
  closed. The host rejects linked,
  multi-link, non-Mach-O, foreign-owned, set-ID, or group/world-writable helper
  candidates; copies verified bytes into its private session as mode `0500`;
  pins SHA-256; and re-verifies the staged binary before every job. The helper
  reads a single-link mode-`0400` input through `O_NOFOLLOW`, caps it at 128 MiB,
  gives PDFKit descriptor-read data rather than a pathname, and emits strict
  bounded JSON. Logical labels, link actions, and optional-content groups are
  inventory only: actions are never executed, targets are escaped inert text,
  and layers cannot be toggled or edited. Mutation output is exclusively created as a private single-link
  file, reopened by PDFKit to verify the requested final state, reparsed and
  fully rendered by Poppler, and promoted only when its copy-time SHA-256 equals
  the validated digest. Input/request identity and digests, exact workspace
  topology, source digest, and output page count are rechecked around the job.
  These checks do not prove byte/object preservation, signature survival,
  arbitrary tag/layer/appearance preservation, or standards conformance.
- The password-protection route is local macOS PDFKit only and fixes the
  envelope to AES-128/R4/V4/AESV2. It creates a separate derived copy from an
  immutable source and accepts only a printable-ASCII 12–16 character open
  password and distinct 12–32 character owner password with no edge whitespace.
  The open-password ceiling avoids a measured PDFKit owner-classification
  defect for lengths 17–31. The only profiles are `accessibility-only`,
  `copy-accessibility`, `print-only`, and `deny-all`; PDF permissions are
  advisory, not arbitrary permission controls. It accepts at most 100 pages and 128 MiB,
  rejects encrypted, tagged, form, JavaScript, signed, attachment-bearing, and
  URL-bearing sources, and validates both the encryption dictionary and an
  unauthenticated Poppler open failure before promotion. Credentials cross
  token-authenticated same-origin loopback HTTP as bounded JSON and then reach
  the helper through bounded private stdin. They are not intentionally retained
  in app state, files, results, provenance, argv, or application logs; fields
  and mutable request buffers are cleared after use, although browser developer
  tools, instrumentation, and process memory may retain transient copies. The resulting PDF is reopened and fully rendered
  before its validated digest permits artifact promotion. There is no selectable
  AES/AES-256 profile, recovery flow, certificate encryption, or general
  permission editor.
- Protection removal is a separate current-session operation, not a general
  decryption surface. It accepts only an exact retained artifact created by the
  fixed protection route and binds its validated provenance, permission
  profile, digest, and page count to one of the four measured AES-128 envelopes.
  A fresh locked PDFKit document must unlock with exact technical owner status
  before page access or copying. Strict catalog/page/action/form/signature/tag/
  attachment/URL/media/presentation and passive-annotation checks run first.
  Pages and bounded direct/GoTo outlines are rebuilt in a fresh document; a
  private postflight requires boxes, rotations, ordered annotation descriptors,
  stable metadata, outline destinations, text hashes, and render hashes to
  match after a no-password reopen. The host independently requires a classic
  final trailer without `/Encrypt`, matching provenance-bound page count,
  passive Poppler inspection, every-page rendering, and digest-bound promotion.
  The cleartext host artifact is consumed after its one transfer, including an
  interrupted transfer; the GUI also attempts authenticated same-origin
  deletion when blob retrieval does not complete. The protected artifact and immutable source remain.
  This provides no recovery, cracking, bypass, arbitrary decryption, secure
  erasure, legal-ownership proof, signature-safe rewriting, sanitization,
  redaction, or byte/object preservation.
- Metadata sanitization is a separate fixed profile over the immutable source,
  not a broad hidden-data cleaner. It accepts at most 100 pages/128 MiB and
  rejects encryption, signatures, forms, tags, layers, attachments, external
  URLs, active content, name trees, and unsupported catalog/page graphs. The
  helper rebuilds accepted pages and bounded local outlines in a fresh
  `PDFDocument`, removes document Info, custom Info, and catalog XMP, and then
  handles PDFKit's three injected Info values only when the generated bytes
  have the exact expected single classic-xref shape. It blanks those literal
  dictionary entries without moving offsets and fails closed on any ambiguity.
  Native reopen requires an empty Info dictionary/no XMP plus matching page
  boxes, rotations, ordered passive annotations, outlines, text hashes, and
  render hashes. Independent Poppler checks require standard/custom/XMP
  metadata absence, passive unsigned output, unchanged page count, every-page
  rendering, and digest-bound promotion. This does not remove orphan objects,
  incremental revisions, unrelated hidden data, or prior bytes, and it does
  not provide secure erasure, signature preservation, or byte preservation.
- Offline signature inspection uses a new host-owned, job-private NSS directory
  and fixed `pdfsig -nocert -no-ocsp` arguments. It returns only sanitized
  integrity/coverage evidence (no raw tool output or paths). Separately, an
  second fixed Poppler pass is allowed only after Poppler reports valid
  integrity. It streams each CMS through an exact pre-created FIFO inventory in
  a mode-`0500` private directory. Host readers retain no more than 1 MiB per
  signature or 8 MiB total and abort on the first excess byte; FIFO backpressure
  prevents regular-file growth. Only a successful bounded receipt is promoted
  to private regular files. Descriptor-reading each ByteRange-excluded direct
  string remains defense in depth; descriptor/digest postflight remains
  mandatory. The host digest-binds that bounded output and its signed
  byte ranges to an optional digest-pinned macOS Foundation/Security/CryptoKit
  helper. The helper accepts bounded DER or BER, verifies the exact detached CMS
  against those ranges, then uses `SecPolicyCreateBasicX509` at one host-current
  time against the current Mac trust configuration. It disables and verifies
  disabled certificate fetching; unsupported subfilters, malformed CMS/BER,
  signature mismatches, and bounded-resource cases fail closed. Poppler's
  integrity/coverage result is labeled as engine-scoped; an unavailable or
  indeterminate exact-CMS cross-check makes the overall conclusion indeterminate,
  with negative records prioritized and omitted counts disclosed. This does not mean offline/no-Keychain validation or establish
  signer identity, PDF-signing key usage, validity at signing time, revocation,
  OCSP, CRL, LTV, trusted timestamps, DocMDP/certification permissions, legal
  effect, or trust on another system. The native parser is unsandboxed and is a
  residual compromise boundary.
- Raster mutation discloses and records loss of vectors, forms, links, tags,
  layers, and signatures. The `verified-raster-burn-v2` redaction subset binds
  declared source text transiently to an unrotated selected region or the
  entire selected page whose CropBox matches its MediaBox, requires
  opaque-black target pixels and exact non-target pixel equality, and rejects
  output unless it is passive, unsigned, textless, attachment-free, and
  object-URL-free. It does not claim object-level sanitization; rotated source
  pages and differing CropBox/MediaBox geometry are unsupported. Before any
  source-side native call, the host descriptor-copies the recorded digest into
  one private single-link job file, changes it to mode `0400`, uses only that
  path for the full pipeline, and rechecks its inode metadata and digest plus
  the store source before promotion.
- Embedded files are listed only. The app does not open attachments, run
  signing credentials, execute plugins, or call cloud services. Link and
  active-content behavior within the browser-native viewer remains controlled
  by the browser, not this app.
- Signed plugin packages use canonical Ed25519 verification, scoped publisher
  trust, content-addressed installs, exact dependency pins, and controlled
  rollback. Active launch descriptors rehash the signed inventory after
  dependency resolution. Private RPC transport buffers at most one bounded
  frame, caps cumulative input and output, honors backpressure, and revokes the
  activation grant and document handle on EOF, truncation, cancellation, or
  broker failure. The canonical worker-control codec accepts only four exact
  bound message forms and forbids paths, document IDs, environment values,
  executable names, and arbitrary arguments. These services are not exposed as
  executable plugin routes. Every bounded document-range read opens the recorded
  source with no-follow semantics, requires a private single-link regular file
  owned by the host user, correlates path and descriptor identity, and verifies
  stable descriptor metadata plus the recorded full-file SHA-256 before and
  after returning bytes.
- The macOS Seatbelt probe currently observes denied network, write,
  sensitive-file-read, and process-fork attempts. Its allow-default profile is
  diagnostic only. Separate fixed Node permission canaries observe denied
  filesystem, child-process, worker-thread, and network APIs, but Node
  permissions are not treated as a malicious-code sandbox. The combined probe
  also observes a fixed inherited `RLIMIT_CPU` canary, without treating it as
  aggregate descendant accounting. It explicitly reports `osSandbox: false`;
  it does not prove
  complete filesystem isolation, CPU containment, hard memory containment, or
  a supported long-term sandbox interface.

## Threats and residual risk

| Boundary | Main threat | Current posture and residual risk |
| --- | --- | --- |
| Loopback API | Drive-by requests, DNS rebinding, token theft | Exact Host, same-origin mutation checks, custom token, no CORS/cookies. A browser compromise can still access browser-held state. |
| Uploaded document | Parser memory corruption or denial of service | Immutable copy, archive/page/pixel/size limits, bounded queue, process I/O and deadlines. Enabled native engines remain attack surfaces; Node does not provide hard CPU/memory/network isolation. |
| Temp storage | Disclosure, traversal, partial artifacts | Private modes, opaque IDs, internally constructed paths, partial-file cleanup, process-owned root. Host/process crash cleanup still depends on OS temp lifecycle. |
| Derived output | Source overwrite, partial/corrupt result, misleading “Save” | Separate artifacts, size/header/digest checks, Poppler reparsing, expected page counts, OCR text-layer checks, and explicit derived labels. Object-level semantic validation remains function-specific. |
| OCR | Misrecognition, private vocabulary disclosure, and loss of semantics | Separate rasterized output, installed-language validation, low-confidence evidence, source preservation, strict user-word normalization, a private host-owned per-job file, and count/digest-only provenance. User words guide Tesseract but do not guarantee recognition or train a model. Forms, links, tags, vectors, and signatures are not preserved. |
| OCR suspect review export | Stale or substituted OCR evidence, decision reassignment, report tampering, text disclosure, or false correction claims | `local-ocr-suspect-review-export-v1` snapshots the current validated source/artifact/parameter binding and at most 500 suspect records, keys each decision by a canonical suspect digest, rejects duplicate identities and incomplete decisions, and emits at most 4 MiB of recursively key-sorted digest-bound JSON. The report contains recognized suspect text, remains local to the explicit download, and declares that corrections, PDF changes, OCR-artifact changes, and authoritative text are all false. OCR raster pixel geometry is labeled as such and is not treated as source-page geometry. |
| CLI and watch folders | Path races, overwrite, recursive intake, unstable input, unbounded queues | Descriptor snapshots, no-clobber publication, new batch/watch directories, direct-child stable-file intake, sequential execution, fixed session limits, cancellation, and manifests. Same-user ancestor-directory replacement and crash residue remain residual risks. |
| Durable local automation | Source substitution, arbitrary execution, duplicate submission, lease loss, cross-job rollback, lock theft, or unbounded retention | One allowlisted inspection operation, descriptor-copied digest-bound sources, application-scoped submit serialization, exact idempotency binding, one live root owner, lease renewal, fixed retry classes, bounded records and receipts, and restart validation fail closed. No shell, caller-selected executable, flags, environment, network target, HTTP route, or scripting surface exists. Terminal jobs and sources count against finite permanent quotas; active cross-process cancellation, automatic retention, safe stale-lock deletion, and descriptor-pinned ancestor traversal are unavailable. The automation root and same-user ancestor processes must be trusted. |
| Prepress | Misleading preview or unsafe native output | Private source/profile copies, active job limits, strict ICC/TIFF/PNG/PDF validation, engine-exit checks, exact workspace inventory, all-page render checks, digest-bound promotion, and non-certifying receipts. Existing-CMYK retargeting, OutputIntent, spots, trapping, printer marks, PDF/X, press, and production RIP behavior are not certified. |
| Optional standards validator | Mutable validator code, custom-profile injection, path disclosure, incomplete validation, or false conformance | No PATH fallback. Activation requires an exact read-only SHA-256 inventory for a pinned veraPDF 1.30.1 launcher and every transitive component, fixed version/profile probes, a private source copy and process directories, bounded one-job JSON, exit/report consistency, repeated source checks, and mandatory cleanup. No bundle is shipped, so the route is unavailable by default. PDF/X is unsupported; native Java parser memory and process containment remain residual risks. |
| Project bundles | Tampering, stale overwrite, or attaching sidecars to another drawing | Canonical payload hashing, exact source SHA-256 binding, strict bounded state validation, and optimistic revision checks. Manual transfer still relies on the user choosing the intended local file and is not synchronized collaboration. |
| Conversion | Active HTML, archive bombs, malformed Office/CAD/PostScript input | HTML is treated as passive text; ZIP fallback checks central-directory bounds, CRC, expansion and ratio limits. Fixed local converters remain native attack surfaces, and legacy formats fail closed without a working converter. |
| Raster redaction | Covered pixels while hidden text or other sensitive data survives, or different source bytes reaching different native stages | `verified-raster-burn-v2` binds text transiently to an unrotated target region or the entire selected page whose CropBox matches its MediaBox, verifies opaque-black target pixels and unchanged non-target pixels where any remain, then requires a passive, unsigned, textless raster output with no attachments or object URLs. All source-side stages use one digest-bound, no-follow, single-link private copy at mode `0400`, whose identity and digest are rechecked before promotion. It is not selective/object-level sanitization and does not prove removal of unrelated hidden data. |
| Redaction proposal report | Stale or tampered proposal, private text-binding disclosure, false application claim, or workspace race | `source-bound-redaction-plan-report-v1` accepts one exact source/workspace/plan digest request under a read lease, rechecks the immutable source, recomputes the strict plan digest, and emits at most 64 KiB of canonical JSON. Only public page geometry is retained; text-binding HMACs and lengths, page-geometry digests, extracted text, paths, artifacts, and application claims are omitted. The report remains `proposed-not-applied`, declares `pdfBytesChanged:false`, and is neither a redaction certificate nor evidence that a PDF was changed. |
| Incremental metadata edit | Xref/object confusion, stale or substituted source bytes, parser denial of service, hidden XMP, collateral page change, or a false sanitization claim | `local-classic-incremental-metadata-v1` caps the bounded parser at 31 source revisions, 50,000 aggregate xref rows, 100,000 aggregate AST nodes, and 8 MiB of aggregate decoded strings/names; proves revision chronology and object/xref spans; allocates a fresh generation-zero Info object at effective `Size`; and preserves the exact source prefix, root reference, non-target Info, and permanent document ID. Private immutable staging, strict Poppler stderr handling, unsigned/passive admission, separate canonical-tail raw reinspection, independent Poppler standard/custom metadata comparison, text/box/all-page-render equality, file identity, source rehash, and digest-bound promotion apply. Bounded classic or admitted xref/object-stream sources are accepted and the output append is classic. Unsupported controls, encryption, signatures, catalog permissions, reachable XMP, forms, JavaScript, attachments, URLs, repair ambiguity, and no-op requests fail closed. Earlier revisions and orphan bytes remain, so prior metadata may be recoverable and sanitization, privacy removal, signature survival, secure erasure, and general active-content safety are not claimed. |
| Incremental accessibility language/title edit | Stale review or source binding, cross-request result substitution, orphaned derived artifacts, malformed language/title injection, xref/object confusion, active-content admission, collateral page change, or false accessibility and sanitization claims | The GUI offers `local-incremental-document-language-title-v1` only after a current source-bound review reports both document values missing; the authenticated operation itself independently rejects existing values in the immutable source. Exact browser, route, and host contracts bind one conservative lowercase language tag and one trimmed NFC title to the current source digest. Provenance carries the exact normalized request SHA-256, which the browser recomputes before accepting a result. The raw writer rejects active, tagged, annotated, optional-content, PostScript XObject, XMP, existing-value, and unsupported graph surfaces; appends only a replacement Catalog with `/Lang` and a fresh Info with `/Title`; and preserves the source as the exact prefix. Independent raw reparse plus private identity, Poppler page/text/box, fixed all-page render, unsigned-output, source-rehash, cleanup, one-shot artifact retrieval/deletion, and digest-bound promotion checks apply. Historical bytes remain recoverable. Content-item language, tags, structure repair, reading order, PDF/UA or WCAG conformance, sanitization, secure erasure, and signature preservation are not claimed. |
| Incremental local GoTo link | Action injection, xref/object confusion, stale or substituted bytes, hidden active content, collateral page or annotation change, or a false preservation claim | `local-incremental-goto-link-v1` accepts one integer CropBox-contained rectangle and two existing page numbers on a bounded passive unsigned source. Every page must expose explicit integer MediaBox/CropBox geometry, existing annotations are restricted to a fixed passive non-link whitelist, and catalog/page/action/signature/form/attachment/XMP/URL surfaces fail closed. It appends one invisible direct `/Dest [page /Fit]` link with no action dictionary, preserves the exact source prefix, and emits a classic revision. Canonical raw reinspection proves the exact xref/object delta and unchanged effective rows; private source/output identity checks, Poppler page/text/box and fixed 256-pixel all-page render equality, unsigned-output inspection, rollback, and digest-bound promotion apply. Historical bytes remain, so general hyperlinks, sanitization, signature preservation, semantic equality, and print-production equality are not claimed. |
| Square annotation flatten | Forged locator, wrong appearance selection, active appearance content, resource capture, transform error, retained annotation history, collateral page change, or a general-flattening overclaim | `local-square-annotation-flatten-v1` accepts only the sole annotation occurrence in a bounded unsigned, unencrypted, untagged, form-free passive document. Raw admission independently rederives the PDFKit locator and requires one indirect printed `/Square`, a direct rectangle, and exactly one tiny unfiltered resource-free normal Form appearance with identity matrix on an unrotated page with direct resources and no existing XObjects. The fixed vector operator grammar excludes text, images, XObject invocation, graphics state resources, shading, marked content, and inline images. A deletion transaction invokes the exact appearance once as page content and removes `/Annots`; compact rewrite eliminates the target object and prior revisions. Canonical rebuild and separate raw inspection prove an unresolvable target, no reachable annotations, unchanged appearance bytes, exact page binding, one closed classic revision, and preserved Root/Info/ID policy. Private source/output identity, Poppler page/text/box and fixed 256-pixel all-page render equality, unsigned-output inspection, rollback, and digest-bound promotion apply. Multiple annotations, other subtypes, appearance states, filters/resources/groups, optional content, actions, popups, widgets, rotated pages, general annotation/form flattening, sanitization, and signature preservation are not claimed. |
| Metadata sanitization | False confidence that all hidden or historical data was removed, unsafe PDFKit serialization assumptions, or source/output replacement | `macos-pdfkit-metadata-sanitize-v1` removes only document Info, custom Info, and catalog XMP from a strict fresh copy. The helper accepts and scrubs only one exact PDFKit classic-xref shape, reopens the result, and compares bounded visible/passive content snapshots. The host independently checks metadata absence, unsigned passive structure, every-page rendering, source identity, output identity, and artifact digest. Orphan objects, incremental revisions, unrelated hidden data, prior bytes, and crash/storage residue are outside this claim. |
| Current-page extracted-text copy | Wrong-page or stale text copied, clipboard overreach, unbounded disclosure, or native-selection overclaim | The explicit action copies only the nonempty trimmed Poppler extraction for the current physical page, rejects values over 20,000 UTF-16 units, and requires `navigator.clipboard.writeText`. Document-operation and page-generation guards run immediately before the write and suppress success after a stale completion. No fallback, partial copy, host request, artifact, or PDF mutation occurs. A browser clipboard write cannot be undone if the page changes during the pending call; browser permission and clipboard retention remain platform boundaries. This is not arbitrary selection in the native PDF viewer. |
| Native viewer | Browser PDF vulnerability, links, active content, or inconsistent behavior | Treated as an external platform dependency; target-browser testing remains required and app disclosures do not claim control over viewer behavior. |
| Safe raster viewer | Stale page display, active PDF behavior, excessive rendering, malformed image output, retained object URLs, or source-path replacement between inspection and rendering | Authenticated same-origin fixed Poppler CropBox route accepts only an opaque document ID, one inspected page, and integer 36–240 DPI mapped to a capped longest edge. It descriptor-copies the recorded digest into one no-follow, single-link private mode-`0400` job file, uses that path for inspection and `pdftocairo -cropbox`, then rechecks the copy identity/digest and store source, validates a bounded PNG, and cleans up. Abort-and-generation guards, Blob decoding, and URL revocation apply on replacement/exit/close. The result is passive local CropBox rendering that executes no PDF action and has no selectable text; it is not object preservation, layer rendering, or structure-preserving rendering. |
| Rendered-region snapshot and loupe | Malformed or decompression-bomb PNGs, ambiguous coordinates, stale-page output, retained URLs, clipboard overreach, or misleading PDF-preservation claims | Authenticated GET accepts exactly page, integer 36–240 DPI, and one six-decimal normalized top-left rectangle. It reuses the source-bound private CropBox render, then applies a CRC- and structure-validating bounded RGB/RGBA decoder with pixel, compressed-data, inflation, and output limits. Integer-millionth pixel coverage is deterministic: floor left/top and ceil right/bottom. Page-generation and abort guards reject stale work; the GUI decodes the bounded PNG before output. Clipboard writing occurs only from the explicit Copy action through one `image/png` item and is disabled when unavailable; Download is separate. The fixed-240-DPI inspector loupe retains the native full page and revokes its separate Blob URL on refresh, region, page, view, document, close, or unload transitions. The images contain no selectable text, vectors, links, tags, layers, forms, or PDF object structure, and the source is unchanged. Browser clipboard permission behavior and native Poppler parser containment remain platform boundaries. |
| Optional PDFKit inventory and mutation | Malformed-PDF parser compromise, helper replacement, resource exhaustion, source-path replacement, stale/forged locators, private-value disclosure, inherited or orphaned field semantics, retained active content, external-link injection, or misleading structure/edit claims | Private digest-pinned release staging, one descriptor-copied no-follow/single-link mode-`0400` source for every source-side native stage, exact-source fingerprints, fixed protocols, signed/active-input rejection for source-bound edits, timeout/output limits, exact workspace and digest checks, private requested-effect reopen, Poppler reparse/all-page render, and digest-bound artifact promotion. Read-only bookmark inventory is capped at 200 entries and eight levels; only PDFKit-resolved existing local pages become navigation buttons, while unresolved/unsupported actions remain inert and no authoring is claimed. Persistent CropBox and BleedBox each accept one changed selected-page resolved rectangle within its MediaBox; BleedBox must also contain the unchanged TrimBox. Persistent rotation accepts one selected page and an absolute 0/90/180/270-degree target. These paths reject signed and no-op inputs and require native candidate/reopen plus independent Poppler output-state evidence while preserving unrelated page boxes and rotations. Rotation compares annotation count/subtype order; Crop and Bleed also compare a private bounded ordered descriptor of subtype, geometry, flags, contents digest, and action/destination/relationship/appearance shape. For BleedBox, one fixed 256-pixel-long-edge Poppler validation render of every source/output page must match; this does not establish equality at other resolutions or in other renderers. Crop expansion can reveal previously cropped source content. Only resolved geometry is proved; explicit-versus-inherited box syntax is not preserved. Widget values, button states, export/on-state names, appearance data, annotation contents, and local-link rectangles are omitted from receipts/provenance; only non-sensitive control kinds and source/target page numbers are reported. Checkbox mutation accepts only an on/off intent and privately requires a unique root-terminal unflagged two-state appearance, matching raw and public state, and a changed reopened raster; radio and push controls remain inert inventory. The input widget must be the exact object exactly once in direct AcroForm `/Fields`; reopened postflight requires one semantically matching direct field record because PDFKit can rewrite object identity. Local-link authoring admits only one CropBox-contained annotation whose raw `/Dest` and exact redundant `/A /GoTo /D` resolve identically to an existing page; URI, remote, named, launch, submit, script, and additional actions fail closed. A bounded cycle-limited raw graph scan rejects catalog permissions, unsafe page/annotation/outline actions, non-destination name trees, active/signature AcroForm fields, and parent/kid target topology. `/Popup` and `/Parent` references must be reciprocal inert direct members of the page annotation array, preventing hidden related objects from bypassing the scan. Mutation is an explicit separate rewrite and can alter unsupported objects. This is not an App Sandbox/XPC boundary; native memory, filesystem, and network containment are not guaranteed. Developer release builds are not a signed/notarized distribution artifact. |
| Local GoTo link removal | Forged or stale locator, deleting the wrong annotation, action-shape ambiguity, collateral annotation or page-geometry change, private-destination disclosure, or sanitization overclaim | `macos-pdfkit-local-goto-remove-v1` accepts exactly one page/index/fingerprint locator from the bound inspection and only an unsigned, unencrypted, form-free, JavaScript-free source. Native admission recomputes the fingerprint, requires document-global unique raw annotation identity, and privately proves the selected link has identical direct `/Dest` and exact redundant `/A /GoTo /D` local destinations. Candidate and private-file reopen checks require exactly that reachable annotation occurrence to disappear while every remaining ordered passive annotation descriptor, page box, and rotation matches the source snapshot. The digest-bound compact receipt omits the fingerprint and destination. The output is a PDFKit rewrite, not redaction, hidden-object cleanup, orphan-byte scrubbing, prior-revision removal, secure erasure, or byte/indirect-object preservation. |
| Outline bookmark mutation | Private-label or destination disclosure, stale-locator deletion, active or ambiguous destination injection, PDFKit outline normalization, collateral tree/content changes, preservation overclaim, or source/output substitution | The inventory-only statement above applies only to read-only inspection. `macos-pdfkit-outline-v1` accepts exactly one existing page in a 1–100-page source and one NFC 1–1,024-byte label without edge whitespace or Unicode control, format, line-separator, or paragraph-separator characters. It requires a passive unsigned, unencrypted, form-free, JavaScript-free source and fewer than 200 prior direct-destination items (output at most 200) through eight levels; existing GoTo-action outlines fail closed because measured PDFKit serialization normalizes them. Candidate and private-file reopen checks prove one appended top-level direct CropBox destination, the unchanged prior hierarchy/order, page boxes, rotations, passive annotation inventory, and source/output digests. The public receipt retains the page and label SHA-256, not the label. `macos-pdfkit-outline-remove-v1` accepts only an opaque top-level-index/fingerprint locator emitted for a fully inspected raw-direct-destination `/XYZ` leaf, rederives it from the immutable source, and removes exactly that node. It rejects page labels, tags, layers, XMP, custom Info keys, catalog name trees/view preferences, and non-passive page dictionaries; bounded standard Info metadata must match. Candidate and reopen checks require the remaining semantic tree, every page box/rotation, ordered passive annotation inventory, per-page text hash, and fixed render hash to match; the receipt omits title, destination, point, and fingerprint. Nesting, reorder, replacement, non-leaf removal, target coordinates, named/remote/scripted actions, byte/object preservation, signature survival, and general structure editing are not claimed. |
| Future plugins | Arbitrary execution, permission escalation, dependency confusion, helper substitution, PID spoofing, process-tree escape, unbounded output, or cleanup races | `PluginHost.activate()` fails closed. Signed canonical package verification, scoped trust, immutable installs, descriptor-based no-follow/single-link revalidation, manifest-v3 exact source binding, rollback, grants/handles, cumulative framed transport, and one-shot cleanup are host-only foundations. The concrete macOS adapter accepts only privately staged adjacent app-bundle helpers whose whole-file digests, Team ID, CDHashes, designated requirements, hardened runtime, and exact App Sandbox entitlements match a signed host policy. It corroborates static identity with live supervisor and worker PIDs, sends source/control only on anonymous inherited pipes, accepts exactly ready plus completion/failure frames, caps diagnostics/RPC, and owns TERM/KILL/reap of a dedicated process group. Activation transitions terminate prior authorities before commit and quarantine failed termination handles for retry. No production third-party code executes: unsigned SwiftPM artifacts fail identity, no signed/notarized pair is shipped, and a meaningful macOS `RLIMIT_AS` returns `EINVAL`, yielding `hardMemoryQuota: false` and pre-authority termination. Ancestor-directory replacement and supported hard-memory containment remain unresolved. |

The fixed `macos-pdfkit-outline-rename-v1` profile inherits the outline-removal
admission boundary and accepts only the same opaque, source-bound top-level leaf
locator plus one changed trimmed NFC label. It preserves the selected node's
direct destination and position and repeats the page geometry, annotation,
text-hash, fixed-render, and private-reopen proof. Its compact receipt exposes
only the new-label SHA-256; neither title, locator, destination, nor coordinates
leave the helper. Nested or non-leaf rename, no-op rename, reordering, and
destination editing fail closed.

For the future plugin boundary, completion is rejected before invocation begins.
Cleanup requires both the supervisor `close` event and bounded proof that its
dedicated process group disappeared; surviving members receive `SIGKILL`.
Production execution remains blocked by the absent signed/notarized helper pair
and the failed hard-memory attestation.

The general engine process runner kills the direct child on timeout,
cancellation, or output overflow, but it does not provide a platform-neutral
process-group sandbox, hard resource quota, seccomp/seatbelt profile, or network
namespace. The separate macOS plugin adapter does own a dedicated process group
and App-Sandbox identity checks, but its hard-memory bit remains false. Ghostscript,
ImageMagick, and LibreOffice are enabled only behind fixed typed adapters;
external signing, key material, and arbitrary engines are not enabled.

Explicit document close deletes its private host data. Tab/window close sends a
best-effort authenticated deletion request; if the browser terminates it, the
private per-process store remains until the local host shuts down or the OS
cleans its temporary directory.

## High-risk planned functions

- Signing still requires key custody, explicit consent, replay resistance,
  correct CMS/ByteRange construction, timestamping, certificate trust,
  revocation and LTV evidence. The delivered offline integrity/coverage
  inspection does not provide any of those signing or trust guarantees. The
  optional macOS Basic X.509 path result is limited to an exact Poppler-dumped,
  digest- and ByteRange-bound DER or BER CMS at the host-current evaluation time; it is not a
  signing, identity, revocation, timestamp, DocMDP, legal, or trusted-signer
  guarantee.
- Full object-preserving redaction must remove target data from every relevant
  PDF representation. The current verified raster subset is intentionally
  destructive and does not satisfy selective sanitization.
- Accessibility remediation can damage tags and reading order and requires
  deterministic structure validation.
- Complete AEC still needs additional measurement types, reusable toolsets,
  multi-sheet revision identity, and production tolerance evidence beyond the
  delivered source-bound calculations, inert annotations, and bounded
  page-viewport/two-point-line `/Measure` dictionary subset.
- Prepress fixups can change color and print semantics and require authoritative
  standards/conformance engines.
- Catalog entries outside the local implementation policy remain excluded and
  are not executable features.

Do not enable third-party executable plugins until the delivered native boundary
is packaged as a Developer-ID-signed, hardened-runtime, App-Sandbox, notarized
pair; a supported hard-memory control replaces the failing meaningful
`RLIMIT_AS`; and adversarial packaged end-to-end tests prove filesystem,
network, process, CPU, memory, descriptor, IPC, output, rollback, crash, and
recovery containment.
