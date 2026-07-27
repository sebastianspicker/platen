# Redaction extension skeleton

This is a non-executable local-only planning contract; it has no `plugin.json`
or entrypoint. Its 11 assigned records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md).

The trusted host currently supplies mark/preview/report sidecars, a bounded
raster-only application path, exact removal of one eligible inert annotation,
and a fixed metadata-only sanitization path. Raster application requires
declared source text, rasterizes every page, validates rendered output, and
checks extracted-text absence. Selective removal proves the reachable passive
annotation graph changed only by the requested target. Metadata sanitization
removes document Info, custom Info, and catalog XMP from a verified fresh copy
while rejecting unsupported document graphs. None of these paths claims broad
hidden-data cleanup, orphan-object or prior-revision scrubbing, secure erasure,
or general object-preserving redaction.

Permissions/dependencies: inspect and transform only the supplied document; a redaction engine is required. Risks: false confidence from visual overlays, hidden content, OCR text layers, embedded files, and metadata residue. Acceptance plan: fixture targets must be absent from extracted text, content streams, metadata, attachments, and rendered pixels after output; non-target content must remain byte-for-byte stable where the engine guarantees it.
