import {
  MAX_BATCH_FILES,
  MAX_WATCH_FILES,
  boundedPath,
  exactPositionals,
  fail,
  normalizedRegion,
  ocrOptions,
  parsedTokens,
  positiveInteger,
} from './parser-foundation.mjs';
import { parsePrepress } from './parser-prepress.mjs';
import { parseAutomation } from './parser-automation.mjs';
import { parseLayerDefaults } from './parser-layer-defaults.mjs';
import { parseAcroFormCheckbox, parseAcroFormRadio, parseAcroFormTextField, parseAcroFormSignatureField, parseAecMeasurementLegend, parseAdvancedSearch, parseCertificateSign, parseHiddenDataSanitization, parseJpegImage, parseJpegImageReplacement, parsePageLabels, parseSigningIdentities, parseTaggedRemediation } from './parser-signing.mjs';
import { parseScanAppend, parseScannerDiscovery } from './parser-scanner.mjs';
import { parseAccessibilityReview, parseAccessibilityMetadata, parseAecBatchLink, parseAcroFormChoice, parseAdminPluginPackage, parseBatesNumbering, parsePageTransition, parseSnapshotRegion } from './parser-production.mjs';
import { parseFullPageRedactionBatch, parsePrinterMarks } from './parser-full-page-redaction.mjs'; import { parseOoxmlExport } from './parser-ooxml.mjs';
import { parsePageBackground } from './parser-page-background.mjs'; import { parseFastWebView } from './parser-fast-web-view.mjs';
import { parseProfessionalCapability } from './parser-professional.mjs';
const ALLOWLIST_ACTIONS = Object.freeze(['list', 'enroll', 'revoke', 'unrevoke', 'remove']);
const PLUGIN_ID = Object.freeze(/^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u);
const KEY_ID = Object.freeze(/^[A-Za-z0-9._-]{1,80}$/u);
export const CLI_HELP = `Platen local CLI
Usage:
  npm run cli -- engines [--output FILE]
  npm run cli -- inspect INPUT.pdf [--structure] [--tag-text] [--output FILE] | fast-web-view INPUT.pdf --output OUTPUT.pdf
  npm run cli -- accessibility-review INPUT.pdf --output REPORT.json
  npm run cli -- accessibility-metadata INPUT.pdf --language BCP47 --title TITLE --output OUTPUT.pdf
  npm run cli -- signature-review INPUT.pdf --output REPORT.json
  npm run cli -- compare-content PRIMARY.pdf SECONDARY.pdf [--format json|csv] --output REPORT
  npm run cli -- create-blank [--pages N] --output OUTPUT.pdf
  npm run cli -- convert-local INPUT.png --output OUTPUT.pdf
  npm run cli -- text INPUT.pdf [--format json|text|rtf|html|xml] [--output FILE]
  npm run cli -- export-ooxml INPUT.pdf --format word|excel|powerpoint --output OUTPUT.(docx|xlsx|pptx)
  npm run cli -- ocr INPUT.pdf --output OUTPUT.pdf [--language eng] [--cleanup PRESET] [--segmentation MODE]
  npm run cli -- ocr-layout INPUT.pdf [--page N] [--region X,Y,W,H] [--no-tables] [--format json|html|alto] [--output FILE]
  npm run cli -- ocr-batch INPUT.pdf... --output-dir DIRECTORY [--language eng] [--cleanup PRESET] [--segmentation MODE]
  npm run cli -- watch-ocr INPUT_DIRECTORY --output-dir NEW_DIRECTORY [--once] [--max-files N] [--interval-ms N] [--settle-ms N]
  npm run cli -- prepress INPUT.pdf --operation OPERATION [--profile print-review|archive-review] [--format json|xml] [--layout 2x1|2x2] [--page N] [--dpi N] [--output FILE]
  npm run cli -- layer-defaults INPUT.pdf --changes 0:on,1-3:off --output OUTPUT.pdf
  npm run cli -- signing-identities
  npm run cli -- certificate-sign INPUT.pdf --certificate-sha256 DIGEST --page N --field-name NAME --output OUTPUT.pdf [--reason TEXT] [--location TEXT] [--contact TEXT] [--placeholder-bytes N]
  npm run cli -- sanitize-hidden-data INPUT.pdf --output OUTPUT.pdf
  npm run cli -- add-checkbox INPUT.pdf --field-name NAME --page N --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- add-radio-group INPUT.pdf --group-name NAME --options OPTIONS.json --output OUTPUT.pdf
  npm run cli -- acroform-text-field INPUT.pdf --page N --field NAME --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- acroform-signature-field INPUT.pdf --page N --field NAME --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- aec-measurement-legend INPUT.pdf --format json|csv --output LEGEND
  npm run cli -- aec-batch-link INPUT.pdf --links LINKS.json --output OUTPUT.pdf
  npm run cli -- scanner-discovery [--output DISCOVERY.json]
  npm run cli -- scan-append PRIMARY.pdf SCAN.(png|jpg|jpeg|tif|tiff) --after-page N --output OUTPUT.pdf
  npm run cli -- acroform-choice INPUT.pdf --field NAME --page N --rect X,Y,W,H --options OPTIONS.json --output OUTPUT.pdf
  npm run cli -- bates-numbering INPUT.pdf --pages 1,3-5 --output OUTPUT.pdf [--start N] [--prefix TEXT] [--suffix TEXT] [--padding N] [--position POS] [--margin N] [--font-size N]
  npm run cli -- page-transition INPUT.pdf --pages 1,3-5 --duration SECONDS --output OUTPUT.pdf
  npm run cli -- tagged-remediation INPUT.pdf --plan PLAN.json --output OUTPUT.pdf
  npm run cli -- insert-jpeg INPUT.pdf IMAGE.jpg --page N --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- replace-jpeg INPUT.pdf IMAGE.jpg --page N --resource-name NAME --output OUTPUT.pdf
  npm run cli -- page-labels INPUT.pdf --ranges RANGES.json --output OUTPUT.pdf
  npm run cli -- advanced-search INPUT.pdf --query TEXT [--mode literal|wildcard] [--case-sensitive] [--whole-word] [--context N] [--max-results N] --output RESULTS.json
  npm run cli -- specialist-content INPUT.pdf
  npm run cli -- redact-pages INPUT.pdf --pages 1,3-5 --output OUTPUT.pdf
  npm run cli -- printer-marks INPUT.pdf --pages 1,3-5 --output OUTPUT.pdf
  npm run cli -- page-background INPUT.pdf --pages 1,3-5 --color R,G,B --output OUTPUT.pdf
  npm run cli -- snapshot-region INPUT.pdf --page N --region X,Y,W,H [--dpi N] --output OUTPUT.png
  npm run cli -- automation-submit-inspect INPUT.pdf --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit INPUT.pdf --automation-root DIRECTORY (--operation inspect|ocr|output-intent|full-page-redaction | --preset PRESET_ID) [operation options]
  npm run cli -- automation-submit-ocr INPUT.pdf --automation-root DIRECTORY [--language eng] [--cleanup PRESET] [--segmentation MODE] [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit-output-intent INPUT.pdf --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit-full-page-redaction INPUT.pdf --pages 1,2,3 --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit-sequence INPUT.pdf --sequence SEQUENCE_ID --automation-root DIRECTORY [--idempotency-key KEY] [--output REPORT]
  npm run cli -- automation-run --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-status JOB_ID --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-cancel JOB_ID --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-output-list --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-output-copy OUTPUT_ID --sha256 DIGEST --automation-root DIRECTORY --output OUTPUT.pdf
  npm run cli -- automation-output-delete OUTPUT_ID --sha256 DIGEST --automation-root DIRECTORY [--output FILE]
  npm run cli -- admin.plugin-allowlist --action list --trust-root STATE_DIRECTORY [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action enroll --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID --public-key PEM_FILE --plugin-id ID[,ID...] [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action revoke --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action unrevoke --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action remove --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID --expected-fingerprint FINGERPRINT [--output STATE.json]
  npm run cli -- admin.plugin-package --action list|install|activate|rollback --plugin-root PACKAGE_DIRECTORY --trust-root STATE_DIRECTORY [--package PACKAGE.json] [--plugin-id ID] [--version VERSION] [--output STATE.json]
All processing is local. Outputs are created exclusively and never overwrite an
existing path. OCR PDFs are rasterized and do not preserve interactive PDF
structure. Prepress output is review evidence, not press or standards
certification. Accessibility review is heuristic and does not validate PDF/UA.
Content comparison covers extracted text tokens only; it does not prove visual,
layout, reading-order, annotation, or object equivalence. Local conversion is
limited to one bounded non-interlaced 8-bit RGB or RGBA PNG and does not certify
pixel or color fidelity.`;
function parseEngines(command, positionals, output) {
  exactPositionals(positionals, 0);
  return Object.freeze({ command, output });
}
function parseInspect(command, positionals, flags, output) {
  const [input] = exactPositionals(positionals, 1);
  if (flags.has('tag-text') && !flags.has('structure')) {
    fail('CLI_INVALID_OPTION', '--tag-text requires --structure.');
  }
  return Object.freeze({
    command,
    input,
    output,
    structure: flags.has('structure'),
    includeTagText: flags.has('tag-text'),
  });
}
function parseSignatureReview(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output) fail('CLI_INVALID_OPTION', 'The signature-review command requires --output.');
  return Object.freeze({ command, input, output });
}
function parseSpecialistContent(command, positionals) {
  const [input] = exactPositionals(positionals, 1);
  return Object.freeze({ command, input });
}
function parseContentComparison(command, positionals, values, output) {
  const [primaryInput, secondaryInput] = exactPositionals(positionals, 2);
  if (!output) fail('CLI_INVALID_OPTION', 'The compare-content command requires --output.');
  const format = values.get('format') ?? 'json';
  if (!['json', 'csv'].includes(format)) {
    fail('CLI_INVALID_OPTION', '--format must be json or csv for compare-content.');
  }
  return Object.freeze({ command, primaryInput, secondaryInput, output, format });
}
function parseCreateBlank(command, positionals, values, output) {
  exactPositionals(positionals, 0);
  if (!output) fail('CLI_INVALID_OPTION', 'The create-blank command requires --output.');
  const pages = values.has('pages')
    ? positiveInteger(values.get('pages'), '--pages', 500)
    : 1;
  return Object.freeze({ command, pages, output });
}
function parseLocalConversion(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!/\.png$/iu.test(input)) {
    fail('CLI_INVALID_OPTION', 'The convert-local executable subset accepts .png input only.');
  }
  if (!output) fail('CLI_INVALID_OPTION', 'The convert-local command requires --output.');
  if (!/\.pdf$/iu.test(output)) {
    fail('CLI_INVALID_OPTION', 'The convert-local output must use the .pdf extension.');
  }
  return Object.freeze({ command, input, output });
}
function parseText(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const format = values.get('format') ?? 'json';
  if (!['json', 'text', 'rtf', 'html', 'xml'].includes(format)) {
    fail('CLI_INVALID_OPTION', '--format must be json, text, rtf, html, or xml for the text command.');
  }
  if (['rtf', 'html', 'xml'].includes(format) && !output) {
    fail('CLI_INVALID_OPTION', `${format.toUpperCase()} text export requires --output.`);
  }
  return Object.freeze({ command, input, output, format });
}
function parseOcr(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output) {
    fail('CLI_INVALID_OPTION', 'The ocr command requires --output.');
  }
  return Object.freeze({ command, input, output, ...ocrOptions(values) });
}
function parseOcrLayout(command, positionals, values, flags, output) {
  const [input] = exactPositionals(positionals, 1);
  const format = values.get('format') ?? 'json';
  if (!['json', 'html', 'alto'].includes(format)) {
    fail('CLI_INVALID_OPTION', '--format must be json, html, or alto for OCR layout.');
  }
  if (format === 'alto' && !output) {
    fail('CLI_INVALID_OPTION', 'ALTO output requires --output.');
  }
  const page = values.has('page')
    ? positiveInteger(values.get('page'), '--page', 10_000)
    : 1;
  const region = values.has('region')
    ? normalizedRegion(values.get('region'))
    : null;
  return Object.freeze({
    command,
    input,
    output,
    format,
    page,
    region,
    detectTables: !flags.has('no-tables'),
    ...ocrOptions(values),
  });
}

function requiredOutputDirectory(values, commandName) {
  const outputDirectory = values.has('output-dir')
    ? boundedPath(values.get('output-dir'), 'Output directory')
    : null;
  if (!outputDirectory) {
    fail('CLI_INVALID_OPTION', `The ${commandName} command requires --output-dir.`);
  }
  return outputDirectory;
}

function parseOcrBatch(command, positionals, values) {
  const inputs = exactPositionals(positionals, 1, MAX_BATCH_FILES);
  const outputDirectory = requiredOutputDirectory(values, 'ocr-batch');
  return Object.freeze({
    command,
    inputs: Object.freeze(inputs),
    outputDirectory,
    ...ocrOptions(values),
  });
}

function parsePluginIds(value) {
  const normalized = typeof value === 'string'
    ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];
  if (normalized.length === 0) fail('CLI_INVALID_OPTION', '--plugin-id requires at least one plugin-id.');
  if (new Set(normalized).size !== normalized.length || normalized.some((pluginId) => !PLUGIN_ID.test(pluginId))) {
    fail('CLI_INVALID_OPTION', '--plugin-id entries must be unique and use a canonical plugin-id format.');
  }
  return normalized;
}
function parseAdminPluginAllowlist(command, positionals, values) {
  exactPositionals(positionals, 0);
  const action = values.get('action');
  if (!action || !ALLOWLIST_ACTIONS.includes(action)) {
    fail('CLI_INVALID_OPTION', '--action must be list, enroll, revoke, unrevoke, or remove.');
  }
  if (!values.has('trust-root')) {
    fail('CLI_INVALID_OPTION', '--trust-root is required for admin.plugin-allowlist actions.');
  }
  const trustRoot = boundedPath(values.get('trust-root'), 'Trust root');
  const output = values.has('output') ? boundedPath(values.get('output'), 'Output') : null;
  if (action === 'list') {
    if ([...values.keys()].some((key) => key !== 'action' && key !== 'trust-root' && key !== 'output')) {
      fail('CLI_INVALID_OPTION', 'list action only accepts --action, --trust-root, and optional --output.');
    }
    return Object.freeze({ command, action, trustRoot, output });
  }
  const publisherId = values.get('publisher-id');
  const keyId = values.get('key-id');
  if (typeof publisherId !== 'string' || !PLUGIN_ID.test(publisherId)) {
    fail('CLI_INVALID_OPTION', '--publisher-id is required and must use the canonical plugin-id format.');
  }
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) {
    fail('CLI_INVALID_OPTION', '--key-id is required and must be a non-empty ASCII identifier.');
  }
  if (action === 'enroll') {
    const publicKey = values.get('public-key');
    const pluginIds = parsePluginIds(values.get('plugin-id'));
    if (typeof publicKey !== 'string' || !publicKey) {
      fail('CLI_INVALID_OPTION', '--public-key is required for enroll.');
    }
    if ([...values.keys()].some((key) => key !== 'action' && key !== 'trust-root' && key !== 'publisher-id' && key !== 'key-id' && key !== 'public-key' && key !== 'plugin-id' && key !== 'output')) {
      fail('CLI_INVALID_OPTION', 'enroll action accepts only --action, --trust-root, --publisher-id, --key-id, --public-key, --plugin-id, and optional --output.');
    }
    return Object.freeze({
      command,
      action,
      publisherId,
      keyId,
      publicKey,
      pluginIds,
      trustRoot,
      output,
    });
  }
  if (action === 'remove') {
    const expectedFingerprint = values.get('expected-fingerprint');
    if (!/^[a-f0-9]{64}$/u.test(expectedFingerprint ?? '')) {
      fail('CLI_INVALID_OPTION', '--expected-fingerprint is required and must be exact lowercase SHA-256.');
    }
    if ([...values.keys()].some((key) => key !== 'action' && key !== 'trust-root' && key !== 'publisher-id' && key !== 'key-id' && key !== 'expected-fingerprint' && key !== 'output')) {
      fail('CLI_INVALID_OPTION', 'remove action accepts only --action, --trust-root, --publisher-id, --key-id, --expected-fingerprint, and optional --output.');
    }
    return Object.freeze({
      command,
      action,
      publisherId,
      keyId,
      trustRoot,
      output,
      expectedFingerprint,
    });
  }
  if (![...values.keys()].every((key) => key === 'action' || key === 'trust-root' || key === 'publisher-id' || key === 'key-id' || key === 'output')) {
    fail('CLI_INVALID_OPTION', `${action} action accepts only --action, --trust-root, --publisher-id, --key-id, and optional --output.`);
  }
  if (!values.has('publisher-id') || !values.has('key-id')) {
    fail('CLI_INVALID_OPTION', `${action} action requires --publisher-id and --key-id.`);
  }
  return Object.freeze({ command, action, publisherId, keyId, trustRoot, output });
}
function parseWatchOcr(command, positionals, values, flags) {
  const [inputDirectory] = exactPositionals(positionals, 1);
  const outputDirectory = requiredOutputDirectory(values, 'watch-ocr');
  const maxFiles = values.has('max-files')
    ? positiveInteger(values.get('max-files'), '--max-files', MAX_WATCH_FILES)
    : 8;
  const intervalMs = values.has('interval-ms')
    ? positiveInteger(values.get('interval-ms'), '--interval-ms', 60_000)
    : 2_000;
  const settleMs = values.has('settle-ms')
    ? positiveInteger(values.get('settle-ms'), '--settle-ms', 60_000)
    : 1_000;
  if (intervalMs < 500) {
    fail('CLI_INVALID_OPTION', '--interval-ms must be from 500 through 60000.');
  }
  if (settleMs < 250) {
    fail('CLI_INVALID_OPTION', '--settle-ms must be from 250 through 60000.');
  }
  return Object.freeze({
    command,
    inputDirectory,
    outputDirectory,
    maxFiles,
    intervalMs,
    settleMs,
    once: flags.has('once'),
    ...ocrOptions(values),
  });
}
export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    fail('CLI_INVALID_ARGUMENTS', 'CLI arguments must be strings.');
  }
  if (
    !argv.length
    || argv[0] === 'help'
    || argv[0] === '--help'
    || argv[0] === '-h'
  ) return Object.freeze({ command: 'help' });
  const command = argv[0];
  const { values, flags, positionals } = parsedTokens(command, argv.slice(1));
  const output = values.has('output') ? boundedPath(values.get('output'), 'Output') : null;
  if (command === 'engines') return parseEngines(command, positionals, output);
  if (command === 'inspect') return parseInspect(command, positionals, flags, output); if (command === 'fast-web-view') return parseFastWebView(command, positionals, output);
  if (command === 'accessibility-review') {
    return parseAccessibilityReview(command, positionals, output);
  }
  if (command === 'accessibility-metadata') {
    return parseAccessibilityMetadata(command, positionals, values, output);
  }
  if (command === 'aec-batch-link') return parseAecBatchLink(command, positionals, values, output);
  if (command === 'signature-review') {
    return parseSignatureReview(command, positionals, output);
  }
  if (command === 'compare-content') {
    return parseContentComparison(command, positionals, values, output);
  }
  if (command === 'professional-capability') return parseProfessionalCapability(command, positionals, values, output);
  if (command === 'create-blank') {
    return parseCreateBlank(command, positionals, values, output);
  }
  if (command === 'convert-local') {
    return parseLocalConversion(command, positionals, output);
  }
  if (command === 'text') {
    return parseText(command, positionals, values, output);
  }
  if (command === 'export-ooxml') return parseOoxmlExport(command, positionals, values, output);
  if (command === 'ocr') {
    return parseOcr(command, positionals, values, output);
  }
  if (command === 'ocr-layout') {
    return parseOcrLayout(command, positionals, values, flags, output);
  }
  if (command === 'ocr-batch') {
    return parseOcrBatch(command, positionals, values);
  }
  if (command === 'watch-ocr') {
    return parseWatchOcr(command, positionals, values, flags);
  }
  if (command === 'layer-defaults') {
    return parseLayerDefaults(command, positionals, values, output);
  }
  if (command === 'signing-identities') return parseSigningIdentities(command, positionals, output);
  if (command === 'scanner-discovery') return parseScannerDiscovery(command, positionals, output); if (command === 'scan-append') return parseScanAppend(command, positionals, values, output);
  if (command === 'acroform-choice') return parseAcroFormChoice(command, positionals, values, output);
  if (command === 'bates-numbering') return parseBatesNumbering(command, positionals, values, output); if (command === 'page-transition') return parsePageTransition(command, positionals, values, output);
  if (command === 'certificate-sign') return parseCertificateSign(command, positionals, values, output); if (command === 'sanitize-hidden-data') return parseHiddenDataSanitization(command, positionals, output);
  if (command === 'add-checkbox') return parseAcroFormCheckbox(command, positionals, values, output);
  if (command === 'add-radio-group') return parseAcroFormRadio(command, positionals, values, output); if (command === 'acroform-text-field') return parseAcroFormTextField(command, positionals, values, output); if (command === 'acroform-signature-field') return parseAcroFormSignatureField(command, positionals, values, output); if (command === 'aec-measurement-legend') return parseAecMeasurementLegend(command, positionals, values, output);
  if (command === 'tagged-remediation') return parseTaggedRemediation(command, positionals, values, output);
  if (command === 'insert-jpeg') return parseJpegImage(command, positionals, values, output);
  if (command === 'replace-jpeg') return parseJpegImageReplacement(command, positionals, values, output);
  if (command === 'page-labels') return parsePageLabels(command, positionals, values, output);
  if (command === 'advanced-search') return parseAdvancedSearch(command, positionals, values, flags, output);
  if (command === 'specialist-content') return parseSpecialistContent(command, positionals);
  if (command === 'redact-pages') return parseFullPageRedactionBatch(command, positionals, values, output);
  if (command === 'printer-marks') return parsePrinterMarks(command, positionals, values, output); if (command === 'page-background') return parsePageBackground(command, positionals, values, output); if (command === 'snapshot-region') return parseSnapshotRegion(command, positionals, values, output);
  if (command.startsWith('automation-')) return parseAutomation(command, positionals, values, output);
  if (command === 'admin.plugin-allowlist') {
    return parseAdminPluginAllowlist(command, positionals, values);
  }
  if (command === 'admin.plugin-package') {
    return parseAdminPluginPackage(command, positionals, values);
  }
  return parsePrepress(command, positionals, values, output);
}
