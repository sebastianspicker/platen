# AEC extension skeleton

This directory remains a non-executable local-only planning contract; it has no
`plugin.json` or entrypoint. Its 18 assigned records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md). Networked
review sessions are research coverage only. A trusted built-in bridge now
exports and imports self-contained local projects with a canonical,
tamper-evident manifest, the exact source PDF bytes, and the revisioned
workspace.

The Workflows screen now records versioned scale calibrations and distance,
perimeter, area, or count measurements in unrotated PDF user space. These
records are bound by SHA-256 to the immutable source, page, CropBox, rotation,
and workspace revision. On macOS, the pinned PDFKit helper can publish one
selected record into a separate PDF as inert line, ink, or circle annotations;
it reopens their page-space geometry and Poppler reparses and renders every
page. These are ordinary visible annotations, not ISO/PDF calibrated
`/Measure` dictionaries. Existing toolsets, takeoffs, spaces, drawing logs,
tags, revisions, links, legends, project, status, and geospatial descriptors
remain local sidecars. Portable projects contain no paths, credentials,
executables, or networked project state.

Permissions/dependencies: inspect and annotate the supplied drawing only;
Poppler supplies page geometry and the optional macOS PDFKit helper supplies
native annotations. Risks: calibration error, unit mismatch, stale drawing
revisions, PDFKit rewrite behavior, and untraceable quantities. Acceptance
tests prove a 72-point one-foot fixture, SI/display conversions, count without
calibration, stale/revision/CropBox rejection, self-intersection rejection,
source byte identity, helper reopen, and independently rendered output.
