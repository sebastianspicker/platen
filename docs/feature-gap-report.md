# Generated feature-gap report

> Generated from the machine-readable catalog by `npm run report`. Do not edit counts by hand.

- Normalized capability records: 318
- Professional delivery: 210 implemented, 108 planned
- Proof audit: 210 proven, 19 audited executable/limited partials, 89 false/unavailable broad claims, 0 unaudited
- Prototype coverage records: 318
- Planned records assigned to the seven requested skeletons: 47
- Planned records assigned to core or other future packs: 61

Professional delivery is the catalog claim. Prototype tier is a separate, deliberately narrower statement of what the local prototype can presently do. Planned records may have a narrower prototype subset, but that is not a professional implementation. No unaudited capability IDs are present.

## Professional delivery implemented now

- `document.open.local`: Open local document
- `document.open.drag-drop`: Open by drag and drop
- `document.close`: Close document
- `document.download.original`: Download original
- `viewer.native.render`: Native viewer surface
- `viewer.zoom.preview`: Preview zoom
- `viewer.rotate.preview`: Preview rotation
- `viewer.fullscreen`: Fullscreen request
- `platform.plugins.catalog`: Plugin catalog
- `platform.plugins.sandbox-probe`: Local sandbox diagnostic
- `viewer.thumbnails`: Page thumbnails
- `viewer.search`: Document search
- `viewer.advanced-search`: Advanced search
- `viewer.bookmarks`: Bookmarks and outlines
- `viewer.page-layouts`: Page layouts
- `viewer.multidocument-tabs`: Multi-document tabs
- `viewer.split-view`: Split view
- `viewer.reflow`: Reflow view
- `viewer.read-aloud`: Read aloud
- `viewer.attachments`: Attachment inventory
- `viewer.layers`: Layer viewer
- `viewer.destinations`: Named destinations
- `viewer.page-labels`: Logical page labels
- `viewer.document-properties`: Document properties
- `viewer.select-copy`: Select and copy
- `viewer.loupe`: Loupe
- `viewer.snapshot`: Snapshot
- `viewer.rulers-grid`: Grid overlay
- `viewer.presentation-mode`: Presentation mode
- `viewer.navigation-history`: Navigation history
- `create.blank-pdf`: Create blank PDF
- `convert.office-to-pdf`: Convert one bounded ODT to a validated local PDF
- `convert.images-to-pdf`: Convert one bounded PNG to a one-page PDF
- `convert.html-to-pdf`: Convert one bounded attribute-free passive HTML document to a validated local PDF
- `create.clipboard-to-pdf`: Create PDF from one clipboard PNG
- `create.print-to-pdf`: Convert one bounded UTF-8 text file to a passive PDF with macOS CUPS
- `create.postscript-to-pdf`: Convert one bounded PostScript or EPS file to PDF
- `create.cad-to-pdf`: Convert a minimal DXF LINE subset to one PDF page
- `export.word`: Export bounded PDF text to DOCX
- `export.excel`: Export bounded PDF text to XLSX
- `export.powerpoint`: Export bounded PDF text to PPTX
- `export.text-rtf`: Export bounded PDF page text as RTF
- `export.html-xml`: Export bounded PDF page text as HTML or XML
- `export.images`: Export one selected PDF page as a bounded PNG
- `export.selected-region`: Export one normalized PDF region to PNG
- `optimize.compress`: Rewrite one bounded PDF with a measured compression result
- `edit.text`: Replace one bounded PDF text literal
- `edit.add-text`: Add one fixed text run
- `edit.text-reflow`: Reflow one fixed-slot paragraph
- `edit.images`: Insert or replace one baseline JPEG
- `edit.links`: Add an internal page link
- `edit.headers-footers`: Add a fixed header and numbered footer
- `edit.vector-objects`: Add one rectangle vector
- `edit.object-properties`: Edit one Square's bounds and border color
- `edit.find-replace`: Find and replace one bounded PDF literal
- `edit.spellcheck`: Spell checking
- `document.watermarks`: Apply a passive text watermark
- `document.backgrounds`: Apply a solid page background
- `document.bates-numbering`: Apply Bates identifiers to one PDF
- `document.bookmarks-author`: Manage one top-level direct bookmark
- `document.destinations-author`: Add one direct named destination
- `document.attachments-manage`: Remove one embedded file
- `document.layers-manage`: Set existing layer visibility
- `document.metadata-edit`: Edit four bounded PDF Info fields
- `document.actions-javascript`: Remove one document-level JavaScript action
- `pages.merge`: Merge PDFs
- `pages.split`: Split document
- `pages.extract`: Extract pages
- `pages.reorder`: Reorder pages
- `pages.delete`: Delete pages
- `pages.crop`: Crop pages
- `pages.rotate`: Rotate pages
- `pages.insert`: Insert pages
- `pages.replace`: Replace pages
- `pages.duplicate`: Duplicate pages
- `pages.copy-between-documents`: Copy pages between documents
- `pages.page-boxes`: Edit one selected CropBox or BleedBox
- `pages.labels-numbering`: Page labels and numbering
- `pages.reverse-interleave`: Reverse and interleave
- `pages.insert-blank`: Insert one standard blank page
- `pages.transitions`: Page transitions
- `pages.split-by-rule`: Rule-based split
- `review.comments`: Add one sticky Text annotation
- `review.markup-tools`: One inert Highlight annotation
- `review.shared-review`: Local review exchange
- `review.text-markup`: One inert Underline annotation
- `review.drawing-markup`: Fixed line and ink annotations
- `review.text-notes-callouts`: One inert FreeText box
- `review.file-audio-attachments`: File and audio annotations
- `review.measurements`: Review measurements
- `review.annotation-properties`: Update annotation contents and bounds
- `review.annotation-import-export`: Single Text annotation XFDF interchange
- `review.comment-summary`: Comment summaries
- `review.statuses`: Review statuses
- `review.filter-sort`: Filter and sort reviews
- `review.annotation-flatten`: Flatten one square annotation
- `review.review-tracking`: Review tracking
- `review.notifications-mentions`: Mentions and notifications
- `review.comments-to-office`: Comments to office documents
- `forms.fill-save`: Fill one bounded AcroForm field and save
- `forms.source-bound-acroform-fill-save`: Source-bound AcroForm fill and save
- `forms.author`: Author one bounded AcroForm control
- `forms.validate`: Validate bounded AcroForm values
- `forms.detect-fields`: Read-only PDFKit widget inventory
- `forms.static-to-fillable`: Add one text field to a static PDF
- `forms.import-export-data`: Single-field CSV export
- `forms.javascript-actions`: Form JavaScript inventory
- `forms.tab-order-tooltips`: Tab order and tooltips
- `forms.barcode-fields`: Source-bound Code 39 barcode field
- `forms.xfa-compatibility`: XFA presence inspection
- `forms.signature-fields`: Signature fields
- `sign.electronic`: Local electronic signing intent
- `sign.certificate`: Apply certificate signature
- `sign.validate-certificate`: Offline certificate signature validation
- `scan.append-to-document`: Append scanned pages
- `ocr.recognize-text`: Create a bounded searchable OCR PDF
- `ocr.cleanup`: Verified OCR cleanup presets
- `ocr.editable-output`: Editable OCR output
- `ocr.suspect-review`: OCR suspect review
- `ocr.language-detection-selection`: Enumerate and select installed OCR languages
- `ocr.zones-layout`: Typed OCR zones with review layout evidence
- `ocr.table-recognition`: Review-only OCR table candidates
- `ocr.batch-recognition`: Sequential bounded local batch OCR
- `ocr.export-layout-preserving`: Positioned OCR review exports
- `ocr.screenshot-capture`: OCR one clipboard PNG capture
- `security.open-password`: Open password encryption
- `security.permission-controls`: Permission controls
- `security.remove-protection`: Remove protection
- `security.javascript-controls`: JavaScript controls
- `redaction.mark`: Mark for redaction
- `redaction.preview`: Source-bound redaction preview plan
- `redaction.apply`: Apply redactions
- `redaction.find-patterns`: Source-bound sensitive-pattern scan
- `redaction.overlay-labels`: Source-bound redaction label annotation
- `redaction.full-page`: Full-page redaction
- `redaction.batch`: Closed full-page redaction batch
- `redaction.report`: Redaction report
- `sanitize.hidden-data`: Bounded hidden-data sanitization
- `sanitize.metadata`: Remove metadata
- `sanitize.selective-content`: Selective annotation removal
- `compare.content`: Content comparison
- `compare.pixel`: Decoded PNG pixel comparison
- `compare.overlay`: Rendered selected-page red/cyan overlay
- `compare.side-by-side`: Rendered selected-page side-by-side panes
- `compare.annotations`: Workspace annotation comparison
- `compare.batch`: Sequential comparison batch
- `compare.report-export`: Comparison reports
- `compare.package`: Package comparison
- `accessibility.check`: Basic local accessibility review
- `accessibility.report-export`: Accessibility review JSON download
- `accessibility.remediate-tags`: Tag remediation
- `accessibility.reading-order`: Reading order
- `accessibility.heading-list-structure`: Heading and list role heuristics
- `accessibility.table-semantics`: Table semantics
- `accessibility.form-semantics`: Accessible forms
- `accessibility.links-bookmarks`: Accessible links and bookmarks
- `accessibility.artifact-management`: Artifact-role inventory
- `accessibility.alt-text`: Human-authored image alt-text proposal
- `accessibility.document-language-title`: Document language and title metadata
- `accessibility.font-unicode-mapping`: Font ToUnicode and embedding evidence
- `accessibility.screen-reader-permissions`: Screen-reader permissions
- `preflight.profiles`: Preflight profiles
- `preflight.reports`: Preflight reports
- `color.convert`: Color conversion
- `color.output-intents`: Output intents
- `print.transparency-flattening`: Transparency flattening
- `print.bleed-marks`: Bleed and printer marks
- `print.imposition`: Imposition
- `print.font-inspection-embedding`: Font inspection and embedding
- `print.image-resolution-compression`: Print image quality
- `automation.cli-batch`: Admit a bounded PDF batch to durable local automation
- `automation.api`: Admit one PDF through the local automation API
- `automation.watch-folders`: Watch folders
- `automation.action-sequences`: Action sequences
- `automation.javascript`: Declarative automation recipes
- `automation.scheduled-jobs`: Scheduled jobs
- `automation.conditional-workflows`: Conditional workflows
- `automation.variables-presets`: Variables and presets
- `automation.job-queue-retry`: Job queues and retry
- `automation.processing-reports`: Processing reports
- `aec.measurement`: Drawing measurement
- `aec.takeoff`: Source-bound quantity takeoff
- `aec.collaborative-review-sessions`: Source-bound local review session
- `aec.scale-calibration`: Source-bound scale calibration
- `aec.measurement-toolset`: Source-bound measurement tool catalog
- `aec.markup-toolsets`: Source-bound markup toolsets
- `aec.markups-list`: Source-bound markups list
- `aec.custom-columns-formulas`: Source-bound custom columns and formulas
- `aec.spaces-regions`: Source-bound spaces and regions
- `aec.sets-drawing-log`: Source-bound drawing set and initial log
- `aec.sheet-metadata-tags`: Source-bound sheet metadata and tags
- `aec.revision-overlay`: Source-bound revision overlay descriptor
- `aec.batch-slip-sheet`: Source-bound slip-sheet plan
- `aec.batch-link`: Batch link
- `aec.legends`: Source-bound measurement legend
- `aec.offline-projects`: Portable local projects
- `aec.revision-status-workflows`: Source-bound revision status workflows
- `aec.geospatial-documents`: Source-bound affine page coordinates
- `document.embedded-files`: Read-only embedded-file inventory
- `admin.audit-telemetry`: Local administration mutation audit log
- `admin.policy-configuration`: Local plugin package administration policy
- `admin.plugin-allowlist`: Plugin allowlist
- `platform.plugins.install`: Install signed local plugin packages
- `platform.plugins.lifecycle`: Local plugin activation lifecycle
- `platform.plugins.dependency-resolution`: Pinned local plugin dependency resolution
- `platform.plugins.version-compatibility`: Version compatibility
- `platform.plugins.package-verification`: Install-time package verification
- `platform.plugins.capability-conflicts`: Active executable-plugin capability conflicts
- `platform.plugins.upgrade-rollback`: Verified local plugin upgrade and rollback
- `platform.plugins.registry`: Durable local plugin registry

## Prototype coverage by tier

### Exact alpha behavior (210)

- `document.open.local`: Open local document (professional delivery: implemented; proof: proven)
- `document.open.drag-drop`: Open by drag and drop (professional delivery: implemented; proof: proven)
- `document.close`: Close document (professional delivery: implemented; proof: proven)
- `document.download.original`: Download original (professional delivery: implemented; proof: proven)
- `viewer.native.render`: Native viewer surface (professional delivery: implemented; proof: proven)
- `viewer.zoom.preview`: Preview zoom (professional delivery: implemented; proof: proven)
- `viewer.rotate.preview`: Preview rotation (professional delivery: implemented; proof: proven)
- `viewer.fullscreen`: Fullscreen request (professional delivery: implemented; proof: proven)
- `platform.plugins.catalog`: Plugin catalog (professional delivery: implemented; proof: proven)
- `platform.plugins.sandbox-probe`: Local sandbox diagnostic (professional delivery: implemented; proof: proven)
- `viewer.thumbnails`: Page thumbnails (professional delivery: implemented; proof: proven)
- `viewer.search`: Document search (professional delivery: implemented; proof: proven)
- `viewer.advanced-search`: Advanced search (professional delivery: implemented; proof: proven)
- `viewer.bookmarks`: Bookmarks and outlines (professional delivery: implemented; proof: proven)
- `viewer.page-layouts`: Page layouts (professional delivery: implemented; proof: proven)
- `viewer.multidocument-tabs`: Multi-document tabs (professional delivery: implemented; proof: proven)
- `viewer.split-view`: Split view (professional delivery: implemented; proof: proven)
- `viewer.reflow`: Reflow view (professional delivery: implemented; proof: proven)
- `viewer.read-aloud`: Read aloud (professional delivery: implemented; proof: proven)
- `viewer.attachments`: Attachment inventory (professional delivery: implemented; proof: proven)
- `viewer.layers`: Layer viewer (professional delivery: implemented; proof: proven)
- `viewer.destinations`: Named destinations (professional delivery: implemented; proof: proven)
- `viewer.page-labels`: Logical page labels (professional delivery: implemented; proof: proven)
- `viewer.document-properties`: Document properties (professional delivery: implemented; proof: proven)
- `viewer.select-copy`: Select and copy (professional delivery: implemented; proof: proven)
- `viewer.loupe`: Loupe (professional delivery: implemented; proof: proven)
- `viewer.snapshot`: Snapshot (professional delivery: implemented; proof: proven)
- `viewer.rulers-grid`: Grid overlay (professional delivery: implemented; proof: proven)
- `viewer.presentation-mode`: Presentation mode (professional delivery: implemented; proof: proven)
- `viewer.navigation-history`: Navigation history (professional delivery: implemented; proof: proven)
- `create.blank-pdf`: Create blank PDF (professional delivery: implemented; proof: proven)
- `convert.office-to-pdf`: Convert one bounded ODT to a validated local PDF (professional delivery: implemented; proof: proven)
- `convert.images-to-pdf`: Convert one bounded PNG to a one-page PDF (professional delivery: implemented; proof: proven)
- `convert.html-to-pdf`: Convert one bounded attribute-free passive HTML document to a validated local PDF (professional delivery: implemented; proof: proven)
- `create.clipboard-to-pdf`: Create PDF from one clipboard PNG (professional delivery: implemented; proof: proven)
- `create.print-to-pdf`: Convert one bounded UTF-8 text file to a passive PDF with macOS CUPS (professional delivery: implemented; proof: proven)
- `create.postscript-to-pdf`: Convert one bounded PostScript or EPS file to PDF (professional delivery: implemented; proof: proven)
- `create.cad-to-pdf`: Convert a minimal DXF LINE subset to one PDF page (professional delivery: implemented; proof: proven)
- `export.word`: Export bounded PDF text to DOCX (professional delivery: implemented; proof: proven)
- `export.excel`: Export bounded PDF text to XLSX (professional delivery: implemented; proof: proven)
- `export.powerpoint`: Export bounded PDF text to PPTX (professional delivery: implemented; proof: proven)
- `export.text-rtf`: Export bounded PDF page text as RTF (professional delivery: implemented; proof: proven)
- `export.html-xml`: Export bounded PDF page text as HTML or XML (professional delivery: implemented; proof: proven)
- `export.images`: Export one selected PDF page as a bounded PNG (professional delivery: implemented; proof: proven)
- `export.selected-region`: Export one normalized PDF region to PNG (professional delivery: implemented; proof: proven)
- `optimize.compress`: Rewrite one bounded PDF with a measured compression result (professional delivery: implemented; proof: proven)
- `edit.text`: Replace one bounded PDF text literal (professional delivery: implemented; proof: proven)
- `edit.add-text`: Add one fixed text run (professional delivery: implemented; proof: proven)
- `edit.text-reflow`: Reflow one fixed-slot paragraph (professional delivery: implemented; proof: proven)
- `edit.images`: Insert or replace one baseline JPEG (professional delivery: implemented; proof: proven)
- `edit.links`: Add an internal page link (professional delivery: implemented; proof: proven)
- `edit.headers-footers`: Add a fixed header and numbered footer (professional delivery: implemented; proof: proven)
- `edit.vector-objects`: Add one rectangle vector (professional delivery: implemented; proof: proven)
- `edit.object-properties`: Edit one Square's bounds and border color (professional delivery: implemented; proof: proven)
- `edit.find-replace`: Find and replace one bounded PDF literal (professional delivery: implemented; proof: proven)
- `edit.spellcheck`: Spell checking (professional delivery: implemented; proof: proven)
- `document.watermarks`: Apply a passive text watermark (professional delivery: implemented; proof: proven)
- `document.backgrounds`: Apply a solid page background (professional delivery: implemented; proof: proven)
- `document.bates-numbering`: Apply Bates identifiers to one PDF (professional delivery: implemented; proof: proven)
- `document.bookmarks-author`: Manage one top-level direct bookmark (professional delivery: implemented; proof: proven)
- `document.destinations-author`: Add one direct named destination (professional delivery: implemented; proof: proven)
- `document.attachments-manage`: Remove one embedded file (professional delivery: implemented; proof: proven)
- `document.layers-manage`: Set existing layer visibility (professional delivery: implemented; proof: proven)
- `document.metadata-edit`: Edit four bounded PDF Info fields (professional delivery: implemented; proof: proven)
- `document.actions-javascript`: Remove one document-level JavaScript action (professional delivery: implemented; proof: proven)
- `pages.merge`: Merge PDFs (professional delivery: implemented; proof: proven)
- `pages.split`: Split document (professional delivery: implemented; proof: proven)
- `pages.extract`: Extract pages (professional delivery: implemented; proof: proven)
- `pages.reorder`: Reorder pages (professional delivery: implemented; proof: proven)
- `pages.delete`: Delete pages (professional delivery: implemented; proof: proven)
- `pages.crop`: Crop pages (professional delivery: implemented; proof: proven)
- `pages.rotate`: Rotate pages (professional delivery: implemented; proof: proven)
- `pages.insert`: Insert pages (professional delivery: implemented; proof: proven)
- `pages.replace`: Replace pages (professional delivery: implemented; proof: proven)
- `pages.duplicate`: Duplicate pages (professional delivery: implemented; proof: proven)
- `pages.copy-between-documents`: Copy pages between documents (professional delivery: implemented; proof: proven)
- `pages.page-boxes`: Edit one selected CropBox or BleedBox (professional delivery: implemented; proof: proven)
- `pages.labels-numbering`: Page labels and numbering (professional delivery: implemented; proof: proven)
- `pages.reverse-interleave`: Reverse and interleave (professional delivery: implemented; proof: proven)
- `pages.insert-blank`: Insert one standard blank page (professional delivery: implemented; proof: proven)
- `pages.transitions`: Page transitions (professional delivery: implemented; proof: proven)
- `pages.split-by-rule`: Rule-based split (professional delivery: implemented; proof: proven)
- `review.comments`: Add one sticky Text annotation (professional delivery: implemented; proof: proven)
- `review.markup-tools`: One inert Highlight annotation (professional delivery: implemented; proof: proven)
- `review.shared-review`: Local review exchange (professional delivery: implemented; proof: proven)
- `review.text-markup`: One inert Underline annotation (professional delivery: implemented; proof: proven)
- `review.drawing-markup`: Fixed line and ink annotations (professional delivery: implemented; proof: proven)
- `review.text-notes-callouts`: One inert FreeText box (professional delivery: implemented; proof: proven)
- `review.file-audio-attachments`: File and audio annotations (professional delivery: implemented; proof: proven)
- `review.measurements`: Review measurements (professional delivery: implemented; proof: proven)
- `review.annotation-properties`: Update annotation contents and bounds (professional delivery: implemented; proof: proven)
- `review.annotation-import-export`: Single Text annotation XFDF interchange (professional delivery: implemented; proof: proven)
- `review.comment-summary`: Comment summaries (professional delivery: implemented; proof: proven)
- `review.statuses`: Review statuses (professional delivery: implemented; proof: proven)
- `review.filter-sort`: Filter and sort reviews (professional delivery: implemented; proof: proven)
- `review.annotation-flatten`: Flatten one square annotation (professional delivery: implemented; proof: proven)
- `review.review-tracking`: Review tracking (professional delivery: implemented; proof: proven)
- `review.notifications-mentions`: Mentions and notifications (professional delivery: implemented; proof: proven)
- `review.comments-to-office`: Comments to office documents (professional delivery: implemented; proof: proven)
- `forms.fill-save`: Fill one bounded AcroForm field and save (professional delivery: implemented; proof: proven)
- `forms.source-bound-acroform-fill-save`: Source-bound AcroForm fill and save (professional delivery: implemented; proof: proven)
- `forms.author`: Author one bounded AcroForm control (professional delivery: implemented; proof: proven)
- `forms.validate`: Validate bounded AcroForm values (professional delivery: implemented; proof: proven)
- `forms.detect-fields`: Read-only PDFKit widget inventory (professional delivery: implemented; proof: proven)
- `forms.static-to-fillable`: Add one text field to a static PDF (professional delivery: implemented; proof: proven)
- `forms.import-export-data`: Single-field CSV export (professional delivery: implemented; proof: proven)
- `forms.javascript-actions`: Form JavaScript inventory (professional delivery: implemented; proof: proven)
- `forms.tab-order-tooltips`: Tab order and tooltips (professional delivery: implemented; proof: proven)
- `forms.barcode-fields`: Source-bound Code 39 barcode field (professional delivery: implemented; proof: proven)
- `forms.xfa-compatibility`: XFA presence inspection (professional delivery: implemented; proof: proven)
- `forms.signature-fields`: Signature fields (professional delivery: implemented; proof: proven)
- `sign.electronic`: Local electronic signing intent (professional delivery: implemented; proof: proven)
- `sign.certificate`: Apply certificate signature (professional delivery: implemented; proof: proven)
- `sign.validate-certificate`: Offline certificate signature validation (professional delivery: implemented; proof: proven)
- `scan.append-to-document`: Append scanned pages (professional delivery: implemented; proof: proven)
- `ocr.recognize-text`: Create a bounded searchable OCR PDF (professional delivery: implemented; proof: proven)
- `ocr.cleanup`: Verified OCR cleanup presets (professional delivery: implemented; proof: proven)
- `ocr.editable-output`: Editable OCR output (professional delivery: implemented; proof: proven)
- `ocr.suspect-review`: OCR suspect review (professional delivery: implemented; proof: proven)
- `ocr.language-detection-selection`: Enumerate and select installed OCR languages (professional delivery: implemented; proof: proven)
- `ocr.zones-layout`: Typed OCR zones with review layout evidence (professional delivery: implemented; proof: proven)
- `ocr.table-recognition`: Review-only OCR table candidates (professional delivery: implemented; proof: proven)
- `ocr.batch-recognition`: Sequential bounded local batch OCR (professional delivery: implemented; proof: proven)
- `ocr.export-layout-preserving`: Positioned OCR review exports (professional delivery: implemented; proof: proven)
- `ocr.screenshot-capture`: OCR one clipboard PNG capture (professional delivery: implemented; proof: proven)
- `security.open-password`: Open password encryption (professional delivery: implemented; proof: proven)
- `security.permission-controls`: Permission controls (professional delivery: implemented; proof: proven)
- `security.remove-protection`: Remove protection (professional delivery: implemented; proof: proven)
- `security.javascript-controls`: JavaScript controls (professional delivery: implemented; proof: proven)
- `redaction.mark`: Mark for redaction (professional delivery: implemented; proof: proven)
- `redaction.preview`: Source-bound redaction preview plan (professional delivery: implemented; proof: proven)
- `redaction.apply`: Apply redactions (professional delivery: implemented; proof: proven)
- `redaction.find-patterns`: Source-bound sensitive-pattern scan (professional delivery: implemented; proof: proven)
- `redaction.overlay-labels`: Source-bound redaction label annotation (professional delivery: implemented; proof: proven)
- `redaction.full-page`: Full-page redaction (professional delivery: implemented; proof: proven)
- `redaction.batch`: Closed full-page redaction batch (professional delivery: implemented; proof: proven)
- `redaction.report`: Redaction report (professional delivery: implemented; proof: proven)
- `sanitize.hidden-data`: Bounded hidden-data sanitization (professional delivery: implemented; proof: proven)
- `sanitize.metadata`: Remove metadata (professional delivery: implemented; proof: proven)
- `sanitize.selective-content`: Selective annotation removal (professional delivery: implemented; proof: proven)
- `compare.content`: Content comparison (professional delivery: implemented; proof: proven)
- `compare.pixel`: Decoded PNG pixel comparison (professional delivery: implemented; proof: proven)
- `compare.overlay`: Rendered selected-page red/cyan overlay (professional delivery: implemented; proof: proven)
- `compare.side-by-side`: Rendered selected-page side-by-side panes (professional delivery: implemented; proof: proven)
- `compare.annotations`: Workspace annotation comparison (professional delivery: implemented; proof: proven)
- `compare.batch`: Sequential comparison batch (professional delivery: implemented; proof: proven)
- `compare.report-export`: Comparison reports (professional delivery: implemented; proof: proven)
- `compare.package`: Package comparison (professional delivery: implemented; proof: proven)
- `accessibility.check`: Basic local accessibility review (professional delivery: implemented; proof: proven)
- `accessibility.report-export`: Accessibility review JSON download (professional delivery: implemented; proof: proven)
- `accessibility.remediate-tags`: Tag remediation (professional delivery: implemented; proof: proven)
- `accessibility.reading-order`: Reading order (professional delivery: implemented; proof: proven)
- `accessibility.heading-list-structure`: Heading and list role heuristics (professional delivery: implemented; proof: proven)
- `accessibility.table-semantics`: Table semantics (professional delivery: implemented; proof: proven)
- `accessibility.form-semantics`: Accessible forms (professional delivery: implemented; proof: proven)
- `accessibility.links-bookmarks`: Accessible links and bookmarks (professional delivery: implemented; proof: proven)
- `accessibility.artifact-management`: Artifact-role inventory (professional delivery: implemented; proof: proven)
- `accessibility.alt-text`: Human-authored image alt-text proposal (professional delivery: implemented; proof: proven)
- `accessibility.document-language-title`: Document language and title metadata (professional delivery: implemented; proof: proven)
- `accessibility.font-unicode-mapping`: Font ToUnicode and embedding evidence (professional delivery: implemented; proof: proven)
- `accessibility.screen-reader-permissions`: Screen-reader permissions (professional delivery: implemented; proof: proven)
- `preflight.profiles`: Preflight profiles (professional delivery: implemented; proof: proven)
- `preflight.reports`: Preflight reports (professional delivery: implemented; proof: proven)
- `color.convert`: Color conversion (professional delivery: implemented; proof: proven)
- `color.output-intents`: Output intents (professional delivery: implemented; proof: proven)
- `print.transparency-flattening`: Transparency flattening (professional delivery: implemented; proof: proven)
- `print.bleed-marks`: Bleed and printer marks (professional delivery: implemented; proof: proven)
- `print.imposition`: Imposition (professional delivery: implemented; proof: proven)
- `print.font-inspection-embedding`: Font inspection and embedding (professional delivery: implemented; proof: proven)
- `print.image-resolution-compression`: Print image quality (professional delivery: implemented; proof: proven)
- `automation.cli-batch`: Admit a bounded PDF batch to durable local automation (professional delivery: implemented; proof: proven)
- `automation.api`: Admit one PDF through the local automation API (professional delivery: implemented; proof: proven)
- `automation.watch-folders`: Watch folders (professional delivery: implemented; proof: proven)
- `automation.action-sequences`: Action sequences (professional delivery: implemented; proof: proven)
- `automation.javascript`: Declarative automation recipes (professional delivery: implemented; proof: proven)
- `automation.scheduled-jobs`: Scheduled jobs (professional delivery: implemented; proof: proven)
- `automation.conditional-workflows`: Conditional workflows (professional delivery: implemented; proof: proven)
- `automation.variables-presets`: Variables and presets (professional delivery: implemented; proof: proven)
- `automation.job-queue-retry`: Job queues and retry (professional delivery: implemented; proof: proven)
- `automation.processing-reports`: Processing reports (professional delivery: implemented; proof: proven)
- `aec.measurement`: Drawing measurement (professional delivery: implemented; proof: proven)
- `aec.takeoff`: Source-bound quantity takeoff (professional delivery: implemented; proof: proven)
- `aec.collaborative-review-sessions`: Source-bound local review session (professional delivery: implemented; proof: proven)
- `aec.scale-calibration`: Source-bound scale calibration (professional delivery: implemented; proof: proven)
- `aec.measurement-toolset`: Source-bound measurement tool catalog (professional delivery: implemented; proof: proven)
- `aec.markup-toolsets`: Source-bound markup toolsets (professional delivery: implemented; proof: proven)
- `aec.markups-list`: Source-bound markups list (professional delivery: implemented; proof: proven)
- `aec.custom-columns-formulas`: Source-bound custom columns and formulas (professional delivery: implemented; proof: proven)
- `aec.spaces-regions`: Source-bound spaces and regions (professional delivery: implemented; proof: proven)
- `aec.sets-drawing-log`: Source-bound drawing set and initial log (professional delivery: implemented; proof: proven)
- `aec.sheet-metadata-tags`: Source-bound sheet metadata and tags (professional delivery: implemented; proof: proven)
- `aec.revision-overlay`: Source-bound revision overlay descriptor (professional delivery: implemented; proof: proven)
- `aec.batch-slip-sheet`: Source-bound slip-sheet plan (professional delivery: implemented; proof: proven)
- `aec.batch-link`: Batch link (professional delivery: implemented; proof: proven)
- `aec.legends`: Source-bound measurement legend (professional delivery: implemented; proof: proven)
- `aec.offline-projects`: Portable local projects (professional delivery: implemented; proof: proven)
- `aec.revision-status-workflows`: Source-bound revision status workflows (professional delivery: implemented; proof: proven)
- `aec.geospatial-documents`: Source-bound affine page coordinates (professional delivery: implemented; proof: proven)
- `document.embedded-files`: Read-only embedded-file inventory (professional delivery: implemented; proof: proven)
- `admin.audit-telemetry`: Local administration mutation audit log (professional delivery: implemented; proof: proven)
- `admin.policy-configuration`: Local plugin package administration policy (professional delivery: implemented; proof: proven)
- `admin.plugin-allowlist`: Plugin allowlist (professional delivery: implemented; proof: proven)
- `platform.plugins.install`: Install signed local plugin packages (professional delivery: implemented; proof: proven)
- `platform.plugins.lifecycle`: Local plugin activation lifecycle (professional delivery: implemented; proof: proven)
- `platform.plugins.dependency-resolution`: Pinned local plugin dependency resolution (professional delivery: implemented; proof: proven)
- `platform.plugins.version-compatibility`: Version compatibility (professional delivery: implemented; proof: proven)
- `platform.plugins.package-verification`: Install-time package verification (professional delivery: implemented; proof: proven)
- `platform.plugins.capability-conflicts`: Active executable-plugin capability conflicts (professional delivery: implemented; proof: proven)
- `platform.plugins.upgrade-rollback`: Verified local plugin upgrade and rollback (professional delivery: implemented; proof: proven)
- `platform.plugins.registry`: Durable local plugin registry (professional delivery: implemented; proof: proven)

### Executable subset (18)

- `optimize.fast-web-view`: Fast web view (professional delivery: planned; proof: partial)
- `scan.acquire`: Scan acquisition (professional delivery: planned; proof: partial)
- `accessibility.auto-tag`: Automatic tagging (professional delivery: planned; proof: partial)
- `accessibility.color-contrast`: Color and contrast review (professional delivery: planned; proof: partial)
- `collaboration.real-time-review`: Real-time review (professional delivery: planned; proof: partial)
- `collaboration.activity-notifications`: Activity and notifications (professional delivery: planned; proof: partial)
- `collaboration.version-history`: Version history (professional delivery: planned; proof: partial)
- `dms.repository-connectors`: DMS repository connectors (professional delivery: planned; proof: partial)
- `dms.checkin-checkout`: Check in and check out (professional delivery: planned; proof: partial)
- `dms.conflict-resolution`: Conflict resolution (professional delivery: planned; proof: partial)
- `dms.document-locking`: Document locking (professional delivery: planned; proof: partial)
- `portfolios.create`: Create PDF portfolios (professional delivery: planned; proof: partial)
- `portfolios.view-extract`: View and extract portfolios (professional delivery: planned; proof: partial)
- `portfolios.metadata-search`: Portfolio metadata search (professional delivery: planned; proof: partial)
- `portfolios.custom-layout`: Portfolio layouts (professional delivery: planned; proof: partial)
- `integrations.cloud-storage`: Cloud storage integrations (professional delivery: planned; proof: partial)
- `integrations.cad-bim`: CAD and BIM integrations (professional delivery: planned; proof: partial)
- `integrations.sensitivity-labels`: Sensitivity label integrations (professional delivery: planned; proof: partial)

### Local sidecar state (0)


### Local service only (1)

- `scan.duplex-feeder`: Duplex and feeder scanning (professional delivery: planned; proof: partial)

### Descriptor only (0)


### Proposal only (0)


### Blocked (74)

- `create.multiformat-combine`: Combine mixed formats (professional delivery: planned; proof: false)
- `document.flatten-content`: Flatten content (professional delivery: planned; proof: false)
- `pages.resize`: Resize pages (professional delivery: planned; proof: false)
- `review.custom-stamps`: Custom stamps (professional delivery: planned; proof: false)
- `forms.calculate`: Calculate forms (professional delivery: planned; proof: false)
- `forms.distribute-collect`: Distribute and collect forms (professional delivery: planned; proof: false)
- `forms.submit-reset`: Submit and reset actions (professional delivery: planned; proof: false)
- `forms.flatten`: Flatten form fields (professional delivery: planned; proof: false)
- `sign.routed-workflow`: Routed signing workflows (professional delivery: planned; proof: false)
- `sign.audit-trail`: Signature audit trail (professional delivery: planned; proof: false)
- `sign.timestamp`: Trusted timestamp (professional delivery: planned; proof: false)
- `sign.certify-document`: Certify document (professional delivery: planned; proof: false)
- `sign.trust-store`: Trust store (professional delivery: planned; proof: false)
- `sign.revocation-ltv`: Revocation and LTV (professional delivery: planned; proof: false)
- `sign.visible-appearance`: Signature appearance (professional delivery: planned; proof: false)
- `sign.digital-id-management`: Digital ID management (professional delivery: planned; proof: false)
- `sign.batch-sign-seal`: Batch sign and seal (professional delivery: planned; proof: false)
- `sign.identity-verification`: Signer identity verification (professional delivery: planned; proof: false)
- `ocr.user-dictionaries-training`: OCR dictionaries and training (professional delivery: planned; proof: false)
- `security.certificate-encryption`: Certificate encryption (professional delivery: planned; proof: false)
- `security.policy-controls`: Security policy controls (professional delivery: planned; proof: false)
- `security.security-envelopes`: Security envelopes (professional delivery: planned; proof: false)
- `security.information-protection-labels`: Information protection labels (professional delivery: planned; proof: false)
- `security.protected-view`: Protected view (professional delivery: planned; proof: false)
- `security.encryption-aes`: AES encryption profiles (professional delivery: planned; proof: false)
- `compare.cross-format`: Cross-format comparison (professional delivery: planned; proof: false)
- `standards.pdf-a`: PDF/A (professional delivery: planned; proof: false)
- `standards.pdf-x`: PDF/X (professional delivery: planned; proof: false)
- `standards.pdf-ua`: PDF/UA (professional delivery: planned; proof: false)
- `standards.pdf-e`: PDF/E (professional delivery: planned; proof: false)
- `standards.pdf-vt`: PDF/VT (professional delivery: planned; proof: false)
- `standards.pdf-two`: PDF 2.0 (professional delivery: planned; proof: false)
- `preflight.fixups`: Preflight fixups (professional delivery: planned; proof: false)
- `preflight.certified-pdf`: Certified PDF history (professional delivery: planned; proof: false)
- `color.spot-colors`: Spot colors (professional delivery: planned; proof: false)
- `print.output-preview`: Output preview (professional delivery: planned; proof: false)
- `print.separations`: Separations preview (professional delivery: planned; proof: false)
- `print.ink-coverage`: Ink coverage (professional delivery: planned; proof: false)
- `print.overprint-preview`: Overprint preview (professional delivery: planned; proof: false)
- `print.soft-proof`: Soft proof (professional delivery: planned; proof: false)
- `print.trapping`: Color trapping (professional delivery: planned; proof: false)
- `print.variable-data`: Variable print data (professional delivery: planned; proof: false)
- `print.barcode-decoration`: Barcodes and decoration (professional delivery: planned; proof: false)
- `collaboration.share-links`: Share links (professional delivery: planned; proof: false)
- `collaboration.access-expiration`: Share access controls (professional delivery: planned; proof: false)
- `collaboration.projects-workspaces`: Project workspaces (professional delivery: planned; proof: false)
- `dms.retention-records`: Retention and records (professional delivery: planned; proof: false)
- `dms.offline-sync`: Offline synchronization (professional delivery: planned; proof: false)
- `automation.webhooks`: Workflow webhooks (professional delivery: planned; proof: false)
- `automation.preflight-server`: Preflight service (professional delivery: planned; proof: false)
- `automation.batch-print`: Batch print (professional delivery: planned; proof: false)
- `rich-media.audio-video`: Audio and video (professional delivery: planned; proof: false)
- `rich-media.playback-controls`: Rich-media playback (professional delivery: planned; proof: false)
- `three-d.import`: Import 3D content (professional delivery: planned; proof: false)
- `three-d.saved-views-sections`: 3D views and sections (professional delivery: planned; proof: false)
- `three-d.measure-comment`: 3D measurement and comments (professional delivery: planned; proof: false)
- `document.article-threads`: Article threads (professional delivery: planned; proof: false)
- `document.optional-content-groups`: Optional-content behavior (professional delivery: planned; proof: false)
- `geospatial.inspect-measure-markup`: Geospatial inspection (professional delivery: planned; proof: false)
- `integrations.office-addins`: Office add-ins (professional delivery: planned; proof: false)
- `integrations.browser-capture`: Browser capture (professional delivery: planned; proof: false)
- `integrations.email`: Email integration (professional delivery: planned; proof: false)
- `integrations.esign-providers`: E-signature providers (professional delivery: planned; proof: false)
- `integrations.events-webhooks`: Integration events (professional delivery: planned; proof: false)
- `admin.identity-roles`: Identity and roles (professional delivery: planned; proof: false)
- `admin.sso-scim`: SSO and SCIM (professional delivery: planned; proof: false)
- `admin.deployment-packaging`: Deployment packaging (professional delivery: planned; proof: false)
- `admin.update-management`: Update management (professional delivery: planned; proof: false)
- `admin.licensing`: License management (professional delivery: planned; proof: false)
- `admin.data-residency`: Data residency controls (professional delivery: planned; proof: false)
- `admin.usage-reporting`: Usage reporting (professional delivery: planned; proof: false)
- `platform.plugins.rpc`: Plugin RPC (professional delivery: planned; proof: false)
- `platform.plugins.permissions`: Plugin permissions (professional delivery: planned; proof: false)
- `platform.plugins.runtime-sandbox`: Runtime sandbox (professional delivery: planned; proof: false)

### Excluded by policy (15)

- `ai.summarize`: Document summarization (professional delivery: planned; proof: false)
- `ai.ask-document`: Ask document (professional delivery: planned; proof: false)
- `ai.extract-structured-data`: Structured extraction (professional delivery: planned; proof: false)
- `ai.translate`: AI translation (professional delivery: planned; proof: false)
- `ai.rewrite-proofread`: AI rewrite and proofread (professional delivery: planned; proof: false)
- `ai.explain`: AI explanation (professional delivery: planned; proof: false)
- `ai.source-citations`: Source citations (professional delivery: planned; proof: false)
- `ai.multi-document-analysis`: Multi-document analysis (professional delivery: planned; proof: false)
- `ai.generate-images`: Generate images (professional delivery: planned; proof: false)
- `ai.generate-bookmarks`: Generate bookmarks (professional delivery: planned; proof: false)
- `ai.smart-redaction`: AI redaction suggestions (professional delivery: planned; proof: false)
- `ai.form-extraction`: AI form extraction (professional delivery: planned; proof: false)
- `ai.accessibility-suggestions`: AI accessibility suggestions (professional delivery: planned; proof: false)
- `ai.annotation-assist`: AI annotation assistance (professional delivery: planned; proof: false)
- `ai.provider-policy-controls`: AI provider policy controls (professional delivery: planned; proof: false)

## Requested skeleton coverage

### OCR extension (14)

- `scan.acquire`: Scan acquisition (executable-subset)
- `scan.duplex-feeder`: Duplex and feeder scanning (service-only)
- `scan.append-to-document`: Append scanned pages (exact-alpha)
- `ocr.recognize-text`: Create a bounded searchable OCR PDF (exact-alpha)
- `ocr.cleanup`: Verified OCR cleanup presets (exact-alpha)
- `ocr.editable-output`: Editable OCR output (exact-alpha)
- `ocr.suspect-review`: OCR suspect review (exact-alpha)
- `ocr.language-detection-selection`: Enumerate and select installed OCR languages (exact-alpha)
- `ocr.zones-layout`: Typed OCR zones with review layout evidence (exact-alpha)
- `ocr.table-recognition`: Review-only OCR table candidates (exact-alpha)
- `ocr.user-dictionaries-training`: OCR dictionaries and training (blocked)
- `ocr.batch-recognition`: Sequential bounded local batch OCR (exact-alpha)
- `ocr.export-layout-preserving`: Positioned OCR review exports (exact-alpha)
- `ocr.screenshot-capture`: OCR one clipboard PNG capture (exact-alpha)

### Signing extension (13)

- `sign.electronic`: Local electronic signing intent (exact-alpha)
- `sign.certificate`: Apply certificate signature (exact-alpha)
- `sign.validate-certificate`: Offline certificate signature validation (exact-alpha)
- `sign.routed-workflow`: Routed signing workflows (blocked)
- `sign.audit-trail`: Signature audit trail (blocked)
- `sign.timestamp`: Trusted timestamp (blocked)
- `sign.certify-document`: Certify document (blocked)
- `sign.trust-store`: Trust store (blocked)
- `sign.revocation-ltv`: Revocation and LTV (blocked)
- `sign.visible-appearance`: Signature appearance (blocked)
- `sign.digital-id-management`: Digital ID management (blocked)
- `sign.batch-sign-seal`: Batch sign and seal (blocked)
- `sign.identity-verification`: Signer identity verification (blocked)

### Redaction extension (11)

- `redaction.mark`: Mark for redaction (exact-alpha)
- `redaction.preview`: Source-bound redaction preview plan (exact-alpha)
- `redaction.apply`: Apply redactions (exact-alpha)
- `redaction.find-patterns`: Source-bound sensitive-pattern scan (exact-alpha)
- `redaction.overlay-labels`: Source-bound redaction label annotation (exact-alpha)
- `redaction.full-page`: Full-page redaction (exact-alpha)
- `redaction.batch`: Closed full-page redaction batch (exact-alpha)
- `redaction.report`: Redaction report (exact-alpha)
- `sanitize.hidden-data`: Bounded hidden-data sanitization (exact-alpha)
- `sanitize.metadata`: Remove metadata (exact-alpha)
- `sanitize.selective-content`: Selective annotation removal (exact-alpha)

### Accessibility remediation extension (15)

- `accessibility.check`: Basic local accessibility review (exact-alpha)
- `accessibility.report-export`: Accessibility review JSON download (exact-alpha)
- `accessibility.auto-tag`: Automatic tagging (executable-subset)
- `accessibility.remediate-tags`: Tag remediation (exact-alpha)
- `accessibility.reading-order`: Reading order (exact-alpha)
- `accessibility.heading-list-structure`: Heading and list role heuristics (exact-alpha)
- `accessibility.table-semantics`: Table semantics (exact-alpha)
- `accessibility.form-semantics`: Accessible forms (exact-alpha)
- `accessibility.links-bookmarks`: Accessible links and bookmarks (exact-alpha)
- `accessibility.artifact-management`: Artifact-role inventory (exact-alpha)
- `accessibility.alt-text`: Human-authored image alt-text proposal (exact-alpha)
- `accessibility.document-language-title`: Document language and title metadata (exact-alpha)
- `accessibility.color-contrast`: Color and contrast review (executable-subset)
- `accessibility.font-unicode-mapping`: Font ToUnicode and embedding evidence (exact-alpha)
- `accessibility.screen-reader-permissions`: Screen-reader permissions (exact-alpha)

### AI extension (15)

- `ai.summarize`: Document summarization (excluded)
- `ai.ask-document`: Ask document (excluded)
- `ai.extract-structured-data`: Structured extraction (excluded)
- `ai.translate`: AI translation (excluded)
- `ai.rewrite-proofread`: AI rewrite and proofread (excluded)
- `ai.explain`: AI explanation (excluded)
- `ai.source-citations`: Source citations (excluded)
- `ai.multi-document-analysis`: Multi-document analysis (excluded)
- `ai.generate-images`: Generate images (excluded)
- `ai.generate-bookmarks`: Generate bookmarks (excluded)
- `ai.smart-redaction`: AI redaction suggestions (excluded)
- `ai.form-extraction`: AI form extraction (excluded)
- `ai.accessibility-suggestions`: AI accessibility suggestions (excluded)
- `ai.annotation-assist`: AI annotation assistance (excluded)
- `ai.provider-policy-controls`: AI provider policy controls (excluded)

### AEC extension (18)

- `aec.measurement`: Drawing measurement (exact-alpha)
- `aec.takeoff`: Source-bound quantity takeoff (exact-alpha)
- `aec.collaborative-review-sessions`: Source-bound local review session (exact-alpha)
- `aec.scale-calibration`: Source-bound scale calibration (exact-alpha)
- `aec.measurement-toolset`: Source-bound measurement tool catalog (exact-alpha)
- `aec.markup-toolsets`: Source-bound markup toolsets (exact-alpha)
- `aec.markups-list`: Source-bound markups list (exact-alpha)
- `aec.custom-columns-formulas`: Source-bound custom columns and formulas (exact-alpha)
- `aec.spaces-regions`: Source-bound spaces and regions (exact-alpha)
- `aec.sets-drawing-log`: Source-bound drawing set and initial log (exact-alpha)
- `aec.sheet-metadata-tags`: Source-bound sheet metadata and tags (exact-alpha)
- `aec.revision-overlay`: Source-bound revision overlay descriptor (exact-alpha)
- `aec.batch-slip-sheet`: Source-bound slip-sheet plan (exact-alpha)
- `aec.batch-link`: Batch link (exact-alpha)
- `aec.legends`: Source-bound measurement legend (exact-alpha)
- `aec.offline-projects`: Portable local projects (exact-alpha)
- `aec.revision-status-workflows`: Source-bound revision status workflows (exact-alpha)
- `aec.geospatial-documents`: Source-bound affine page coordinates (exact-alpha)

### Prepress extension (26)

- `standards.pdf-a`: PDF/A (blocked)
- `standards.pdf-x`: PDF/X (blocked)
- `standards.pdf-ua`: PDF/UA (blocked)
- `standards.pdf-e`: PDF/E (blocked)
- `standards.pdf-vt`: PDF/VT (blocked)
- `standards.pdf-two`: PDF 2.0 (blocked)
- `preflight.fixups`: Preflight fixups (blocked)
- `preflight.profiles`: Preflight profiles (exact-alpha)
- `preflight.reports`: Preflight reports (exact-alpha)
- `preflight.certified-pdf`: Certified PDF history (blocked)
- `color.convert`: Color conversion (exact-alpha)
- `color.output-intents`: Output intents (exact-alpha)
- `color.spot-colors`: Spot colors (blocked)
- `print.output-preview`: Output preview (blocked)
- `print.separations`: Separations preview (blocked)
- `print.ink-coverage`: Ink coverage (blocked)
- `print.overprint-preview`: Overprint preview (blocked)
- `print.transparency-flattening`: Transparency flattening (exact-alpha)
- `print.soft-proof`: Soft proof (blocked)
- `print.trapping`: Color trapping (blocked)
- `print.bleed-marks`: Bleed and printer marks (exact-alpha)
- `print.imposition`: Imposition (exact-alpha)
- `print.font-inspection-embedding`: Font inspection and embedding (exact-alpha)
- `print.image-resolution-compression`: Print image quality (exact-alpha)
- `print.variable-data`: Variable print data (blocked)
- `print.barcode-decoration`: Barcodes and decoration (blocked)

## Planned outside the seven skeletons

### Create and convert (2)

- `create.multiformat-combine`: Combine mixed formats (blocked)
- `optimize.fast-web-view`: Fast web view (executable-subset)

### Content editing (1)

- `document.flatten-content`: Flatten content (blocked)

### Page organization (1)

- `pages.resize`: Resize pages (blocked)

### Annotations and review (1)

- `review.custom-stamps`: Custom stamps (blocked)

### Forms (4)

- `forms.calculate`: Calculate forms (blocked)
- `forms.distribute-collect`: Distribute and collect forms (blocked)
- `forms.submit-reset`: Submit and reset actions (blocked)
- `forms.flatten`: Flatten form fields (blocked)

### Passwords and certificate security (6)

- `security.certificate-encryption`: Certificate encryption (blocked)
- `security.policy-controls`: Security policy controls (blocked)
- `security.security-envelopes`: Security envelopes (blocked)
- `security.information-protection-labels`: Information protection labels (blocked)
- `security.protected-view`: Protected view (blocked)
- `security.encryption-aes`: AES encryption profiles (blocked)

### Comparison variants (1)

- `compare.cross-format`: Cross-format comparison (blocked)

### Collaboration and DMS (12)

- `collaboration.share-links`: Share links (blocked)
- `collaboration.real-time-review`: Real-time review (executable-subset)
- `collaboration.activity-notifications`: Activity and notifications (executable-subset)
- `collaboration.access-expiration`: Share access controls (blocked)
- `collaboration.version-history`: Version history (executable-subset)
- `collaboration.projects-workspaces`: Project workspaces (blocked)
- `dms.repository-connectors`: DMS repository connectors (executable-subset)
- `dms.retention-records`: Retention and records (blocked)
- `dms.checkin-checkout`: Check in and check out (executable-subset)
- `dms.offline-sync`: Offline synchronization (blocked)
- `dms.conflict-resolution`: Conflict resolution (executable-subset)
- `dms.document-locking`: Document locking (executable-subset)

### Automation and headless (3)

- `automation.webhooks`: Workflow webhooks (blocked)
- `automation.preflight-server`: Preflight service (blocked)
- `automation.batch-print`: Batch print (blocked)

### Rich media, 3D, and portfolios (12)

- `rich-media.audio-video`: Audio and video (blocked)
- `rich-media.playback-controls`: Rich-media playback (blocked)
- `three-d.import`: Import 3D content (blocked)
- `three-d.saved-views-sections`: 3D views and sections (blocked)
- `three-d.measure-comment`: 3D measurement and comments (blocked)
- `portfolios.create`: Create PDF portfolios (executable-subset)
- `portfolios.view-extract`: View and extract portfolios (executable-subset)
- `portfolios.metadata-search`: Portfolio metadata search (executable-subset)
- `portfolios.custom-layout`: Portfolio layouts (executable-subset)
- `document.article-threads`: Article threads (blocked)
- `document.optional-content-groups`: Optional-content behavior (blocked)
- `geospatial.inspect-measure-markup`: Geospatial inspection (blocked)

### Integrations and administration (15)

- `integrations.cloud-storage`: Cloud storage integrations (executable-subset)
- `integrations.office-addins`: Office add-ins (blocked)
- `integrations.browser-capture`: Browser capture (blocked)
- `integrations.email`: Email integration (blocked)
- `integrations.cad-bim`: CAD and BIM integrations (executable-subset)
- `integrations.esign-providers`: E-signature providers (blocked)
- `integrations.sensitivity-labels`: Sensitivity label integrations (executable-subset)
- `integrations.events-webhooks`: Integration events (blocked)
- `admin.identity-roles`: Identity and roles (blocked)
- `admin.sso-scim`: SSO and SCIM (blocked)
- `admin.deployment-packaging`: Deployment packaging (blocked)
- `admin.update-management`: Update management (blocked)
- `admin.licensing`: License management (blocked)
- `admin.data-residency`: Data residency controls (blocked)
- `admin.usage-reporting`: Usage reporting (blocked)

### Plugin platform (3)

- `platform.plugins.rpc`: Plugin RPC (blocked)
- `platform.plugins.permissions`: Plugin permissions (blocked)
- `platform.plugins.runtime-sandbox`: Runtime sandbox (blocked)
