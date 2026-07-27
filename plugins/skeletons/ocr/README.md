# OCR extension skeleton

This is a non-executable local-only planning contract; it has no `plugin.json`
or entrypoint. Its 14 assigned records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md).
The trusted host currently supplies searchable raster OCR, installed-language
selection, confidence suspects, fixed cleanup presets, normalized page/region
recognition, strict TSV/ALTO evidence, positioned review HTML, heuristic
TSV-geometry table grids with formula-injection-safe CSV export, sequential
manifested batch OCR, and bounded stable-file watch OCR. Table output requires
human review and is not authoritative recognition. The skeleton itself remains
disabled. Scanner acquisition,
feeder/duplex control, page append, editable reconstruction, interactive
suspect correction, authoritative tables, dictionaries/training, and
screenshot OCR remain unavailable.

Permissions/dependencies: read and write the explicitly supplied document plus scanner acquisition; an OCR engine adapter is required. Risks: language quality, malicious image payloads, and silently changing source pixels. Acceptance plan: fixture scan recognition must produce the expected text layer, preserve page count and dimensions, reject undeclared paths, and pass a deterministic image hash check.
