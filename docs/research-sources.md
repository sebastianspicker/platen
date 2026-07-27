# Research sources and normalization

The feature catalog is a vendor-neutral normalization of current official
product materials reviewed on 18 July 2026. It is not a claim that every
product implements every row, nor that similarly named features have identical
quality. Product-specific labels are normalized into capability records;
closely related controls may share one workflow record, so the record count is
not a count of individual menu commands.

The versioned machine-readable product list and required IDs are in
`catalog/research-scope.json`. Verified family-level source links are in
`catalog/research-provenance.json`; its contract and tests expressly prevent
those research references from being confused with implementation evidence.
The provenance locators establish why a normalized feature family is in scope,
not an exact product-by-command compatibility matrix.

## Professional products reviewed

- [Adobe Acrobat tools](https://helpx.adobe.com/acrobat/using/explore-acrobat-tools.html)
- [Foxit PDF Editor feature comparison](https://www.foxit.com/pdf-editor/pricing/)
- [Nitro PDF Pro for Windows guide](https://www.gonitro.com/user-guide/nitro-pdf-for-windows)
- [PDF-XChange product comparison](https://cdn.pdf-xchange.com/pdf-xchange-products-comparison-chart)
- [ABBYY FineReader PDF feature list](https://pdf.abbyy.com/media/uicccm1b/brochure-finereaderpdf-full-feature-list-en.pdf)
- [Bluebeam Revu subscription features](https://support.bluebeam.com/revu/subscription/subscription-features.html)
- [callas pdfToolbox](https://callassoftware.com/products/pdftoolbox/)
- [Enfocus PitStop Pro](https://www.enfocus.com/en/pitstop-pro)
- [PDF Expert](https://pdfexpert.com/features)
- [Qoppa PDF Studio](https://www.qoppa.com/pdfstudio/features/)
- [Wondershare PDFelement technical specification](https://pdf.wondershare.com/tech-spec.html)
- [Tungsten Power PDF guide](https://docshield.tungstenautomation.com/PowerPDF/en_US/2025.3-jlrwz2ja2j/help/PowerPDF_help/PowerPDF_help/c_introduction.html)

Additional current-product cross-checks used during review:

- [Adobe Acrobat feature overview](https://www.adobe.com/acrobat/features.html?tab=features-2)
- [Nitro PDF Pro 26 release overview](https://www.gonitro.com/release-hub/nitro-pdf-pro-26)

## Candidate local engine evidence

- [PDF.js](https://mozilla.github.io/pdf.js/) is an Apache-2.0 web-standards PDF
  parser and renderer.
- [qpdf](https://qpdf.readthedocs.io/en/stable/) is an Apache-2.0
  content-preserving PDF transformer.
- [Apache PDFBox](https://pdfbox.apache.org/) is Apache-2.0 and documents
  creation, manipulation, extraction, forms, signing, rendering helpers, and
  baseline preflight functions.
- [Tesseract](https://github.com/tesseract-ocr/tesseract) is an Apache-2.0 local
  OCR engine and uses BSD-licensed Leptonica.
- [veraPDF](https://verapdf.org/home/) is an open standards validator available
  under MPLv2+ or GPLv3+ terms. Its
  [CLI validation reference](https://docs.verapdf.org/cli/validation/)
  documents the fixed PDF/A and PDF/UA flavours, JSON output, failure-display
  bounds, and process controls; the official
  [release page](https://github.com/veraPDF/veraPDF-library/releases) identifies
  1.30.1 as the pinned integration target used by the dormant bundle gate.
- [Ghostscript licensing](https://ghostscript.com/faq/index.html) is
  AGPL/commercial; compatibility must be resolved before any distribution.

Engine names in this document are not approved distribution dependencies. A
typed adapter or dormant trust gate is implementation evidence only for that
narrow boundary, not evidence that an engine bundle ships or a professional
capability is complete.
