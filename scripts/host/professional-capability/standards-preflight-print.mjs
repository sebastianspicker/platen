import {
  standardsPdfA, standardsPdfX, standardsPdfUa, standardsPdfE, standardsPdfVt, standardsPdfTwo,
  createProfessionalPrintDelivery,
} from './standards-preflight-print-core.mjs';
import {
  preflightFixups, preflightProfiles, preflightReports, preflightCertifiedPdf, printOutputPreview,
  printSeparations, printInkCoverage, printOverprintPreview, printTransparencyFlattening, printSoftProof,
  printTrapping, printBleedMarks, printImposition, printFontInspectionEmbedding,
  printImageResolutionCompression, printVariableData, printBarcodeDecoration,
} from './standards-preflight-print-ops.mjs';
import { colorConvert, colorOutputIntents, colorSpotColors } from './standards-preflight-color.mjs';

export {
  standardsPdfA, standardsPdfX, standardsPdfUa, standardsPdfE, standardsPdfVt, standardsPdfTwo,
  createProfessionalPrintDelivery, preflightFixups, preflightProfiles, preflightReports,
  preflightCertifiedPdf, printOutputPreview, printSeparations, printInkCoverage, printOverprintPreview,
  printTransparencyFlattening, printSoftProof, printTrapping, printBleedMarks, printImposition,
  printFontInspectionEmbedding, printImageResolutionCompression, printVariableData,
  printBarcodeDecoration, colorConvert, colorOutputIntents, colorSpotColors,
};

export const handlers = Object.freeze({
  async 'standards.pdf-a'(ctx = {}) { return standardsPdfA(ctx); },
  async 'standards.pdf-x'(ctx = {}) { return standardsPdfX(ctx); },
  async 'standards.pdf-ua'(ctx = {}) { return standardsPdfUa(ctx); },
  async 'standards.pdf-e'(ctx = {}) { return standardsPdfE(ctx); },
  async 'standards.pdf-vt'(ctx = {}) { return standardsPdfVt(ctx); },
  async 'standards.pdf-two'(ctx = {}) { return standardsPdfTwo(ctx); },
  async 'preflight.fixups'(ctx = {}) { return preflightFixups(ctx); },
  async 'preflight.profiles'(ctx = {}) { return preflightProfiles(ctx); },
  async 'preflight.reports'(ctx = {}) { return preflightReports(ctx); },
  async 'preflight.certified-pdf'(ctx = {}) { return preflightCertifiedPdf(ctx); },
  async 'color.convert'(ctx = {}) { return colorConvert(ctx); },
  async 'color.output-intents'(ctx = {}) { return colorOutputIntents(ctx); },
  async 'color.spot-colors'(ctx = {}) { return colorSpotColors(ctx); },
  async 'print.output-preview'(ctx = {}) { return printOutputPreview(ctx); },
  async 'print.separations'(ctx = {}) { return printSeparations(ctx); },
  async 'print.ink-coverage'(ctx = {}) { return printInkCoverage(ctx); },
  async 'print.overprint-preview'(ctx = {}) { return printOverprintPreview(ctx); },
  async 'print.transparency-flattening'(ctx = {}) { return printTransparencyFlattening(ctx); },
  async 'print.soft-proof'(ctx = {}) { return printSoftProof(ctx); },
  async 'print.trapping'(ctx = {}) { return printTrapping(ctx); },
  async 'print.bleed-marks'(ctx = {}) { return printBleedMarks(ctx); },
  async 'print.imposition'(ctx = {}) { return printImposition(ctx); },
  async 'print.font-inspection-embedding'(ctx = {}) { return printFontInspectionEmbedding(ctx); },
  async 'print.image-resolution-compression'(ctx = {}) { return printImageResolutionCompression(ctx); },
  async 'print.variable-data'(ctx = {}) { return printVariableData(ctx); },
  async 'print.barcode-decoration'(ctx = {}) { return printBarcodeDecoration(ctx); },
});
