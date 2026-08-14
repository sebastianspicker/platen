// Keep the core JavaScript inventory below the source-layout boundary by
// isolating bounded AcroForm barcode and JavaScript-review production slices.
export const REQUIRED_JAVASCRIPT_FORMS_FILES = Object.freeze([
  'scripts/host/pdf-acroform-barcode-contract.mjs',
  'scripts/host/pdf-acroform-barcode-writer.mjs',
  'scripts/host/pdf-acroform-barcode-job.mjs',
  'scripts/host/pdf-acroform-barcode-service.mjs',
  'scripts/host/pdf-acroform-barcode.mjs',
  'scripts/host/pdf-form-javascript-contract.mjs',
  'scripts/host/pdf-form-javascript-analyzer.mjs',
  'scripts/host/pdf-form-javascript-job.mjs',
  'scripts/host/pdf-form-javascript-service.mjs',
  'scripts/host/pdf-form-javascript.mjs',
  'scripts/host/pdf-xfa-inspection-contract.mjs',
  'scripts/host/pdf-xfa-inspection-analyzer.mjs',
  'scripts/host/pdf-xfa-inspection-job.mjs',
  'scripts/host/pdf-xfa-inspection-service.mjs',
  'scripts/host/pdf-xfa-inspection.mjs',
]);
