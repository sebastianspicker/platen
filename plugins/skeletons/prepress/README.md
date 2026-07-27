# Prepress extension skeleton

This remains a non-executable extension planning contract; it has no `plugin.json`
or entrypoint. Its assigned professional records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md).

The trusted host now provides executable local subsets for fixed print/archive
preflight review, font/image and page-box inspection, Ghostscript CMYK page-average
coverage, bounded separation and simulated-overprint previews, fixed-profile
CMYK-targeted normalization, deterministic 2-up/4-up row-major N-up, and a
source-bound print-production review receipt. Derived PDFs require exit-zero
Ghostscript execution, exact source/profile hashes, Poppler parse and page-box
checks, normalized text equivalence, rendering of every output page, and
digest-bound promotion. The immutable source is never overwritten.

These subsets are deliberately non-certifying. The exact installed Ghostscript
default CMYK printer profile is copied privately, validated, and named by digest
in the receipt, but existing DeviceCMYK is not
retargeted, Separation/DeviceN is preserved, and no OutputIntent is assigned or
validated. PDF/X, custom/imported ICC profiles and fixups, localized TAC,
spot-color aliasing, soft proof, trapping, production crop/registration/color-bar
marks, booklet/signature/creep/step-and-repeat imposition, and production-RIP
validation remain unavailable. Requests for printer marks fail explicitly; no
raster fallback is presented as production imposition.

Permissions/dependencies: inspect and transform only the supplied print file; a preflight engine is required. Risks: profile mismatch, destructive fixups, color-management drift, and output-intent loss. Acceptance plan: conformance fixtures must produce stable pass/fail reports, named fixups must change only expected objects, and separation/output-preview fixtures must match fixed ink and overprint assertions.
