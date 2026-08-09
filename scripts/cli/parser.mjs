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
import { parsePrepress } from './parser-prepress.mjs'; import { parseAutomation } from './parser-automation.mjs';
import { parseLayerDefaults } from './parser-layer-defaults.mjs'; import { parseAcroFormCheckbox, parseAcroFormRadio, parseAcroFormTextField, parseAcroFormSignatureField, parseAecMeasurementLegend, parseAdvancedSearch, parseCertificateSign, parseHiddenDataSanitization, parseJpegImage, parseJpegImageReplacement, parsePageLabels, parseSigningIdentities, parseTaggedRemediation } from './parser-signing.mjs';
import { parseScanAppend, parseScannerDiscovery } from './parser-scanner.mjs'; import { parseAccessibilityReview, parseAccessibilityMetadata, parseAecBatchLink, parseAcroFormChoice, parseAdminPluginPackage, parseAdminPolicyConfiguration, parseAdminAuditTelemetry, parseBatesNumbering, parsePageTransition, parseSnapshotRegion } from './parser-production.mjs';
import { parseFullPageRedactionBatch, parsePrinterMarks } from './parser-full-page-redaction.mjs'; import { parseOoxmlExport } from './parser-ooxml.mjs';
import { parsePageBackground } from './parser-page-background.mjs'; import { parseFastWebView } from './parser-fast-web-view.mjs';
import { parsePageWatermark } from './parser-page-watermark.mjs'; import { parseProfessionalCapability } from './parser-professional.mjs'; import { parseTextReflow } from './parser-text-reflow.mjs';
import { parseCadPdfCreation, parseHtmlConversion, parseOptimizeCompress, parsePagePngExport, parsePostscriptConversion, parseStructuredExport } from './parser-r02.mjs';
import { parsePrintToPdf } from './parser-print-to-pdf.mjs';
const ALLOWLIST_ACTIONS = Object.freeze(['list', 'enroll', 'revoke', 'unrevoke', 'remove']); const PLUGIN_ID = Object.freeze(/^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u);
const KEY_ID = Object.freeze(/^[A-Za-z0-9._-]{1,80}$/u);
import { CLI_HELP } from './parser-help.mjs';
export { CLI_HELP };
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
function parseOfficeLocalConversion(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!/\.odt$/iu.test(input)) {
    fail('CLI_INVALID_OPTION', 'The convert-office-local executable subset accepts .odt input only.');
  }
  if (!output) fail('CLI_INVALID_OPTION', 'The convert-office-local command requires --output.');
  if (!/\.pdf$/iu.test(output)) {
    fail('CLI_INVALID_OPTION', 'The convert-office-local output must use the .pdf extension.');
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
const ALLOWLIST_LIST_OPTIONS = Object.freeze(['action', 'trust-root', 'output']);
const ALLOWLIST_ENROLL_OPTIONS = Object.freeze([
  'action', 'trust-root', 'publisher-id', 'key-id', 'public-key', 'plugin-id', 'output',
]);
const ALLOWLIST_REMOVE_OPTIONS = Object.freeze([
  'action', 'trust-root', 'publisher-id', 'key-id', 'expected-fingerprint', 'output',
]);
const ALLOWLIST_STATE_OPTIONS = Object.freeze([
  'action', 'trust-root', 'publisher-id', 'key-id', 'output',
]);
function requireOnlyOptions(values, allowed, message) {
  if ([...values.keys()].some((key) => !allowed.includes(key))) {
    fail('CLI_INVALID_OPTION', message);
  }
}
function requiredAllowlistIdentity(values) {
  const publisherId = values.get('publisher-id');
  const keyId = values.get('key-id');
  if (typeof publisherId !== 'string' || !PLUGIN_ID.test(publisherId)) {
    fail('CLI_INVALID_OPTION', '--publisher-id is required and must use the canonical plugin-id format.');
  }
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) {
    fail('CLI_INVALID_OPTION', '--key-id is required and must be a non-empty ASCII identifier.');
  }
  return { publisherId, keyId };
}
function parseAllowlistList({ command, action, values, trustRoot, output }) {
  requireOnlyOptions(
    values,
    ALLOWLIST_LIST_OPTIONS,
    'list action only accepts --action, --trust-root, and optional --output.',
  );
  return Object.freeze({ command, action, trustRoot, output });
}
function parseAllowlistEnroll({ command, action, values, trustRoot, output }) {
  const { publisherId, keyId } = requiredAllowlistIdentity(values);
  const publicKey = values.get('public-key');
  const pluginIds = parsePluginIds(values.get('plugin-id'));
  if (typeof publicKey !== 'string' || !publicKey) {
    fail('CLI_INVALID_OPTION', '--public-key is required for enroll.');
  }
  requireOnlyOptions(
    values,
    ALLOWLIST_ENROLL_OPTIONS,
    'enroll action accepts only --action, --trust-root, --publisher-id, --key-id, --public-key, --plugin-id, and optional --output.',
  );
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
function parseAllowlistRemove({ command, action, values, trustRoot, output }) {
  const { publisherId, keyId } = requiredAllowlistIdentity(values);
  const expectedFingerprint = values.get('expected-fingerprint');
  if (!/^[a-f0-9]{64}$/u.test(expectedFingerprint ?? '')) {
    fail('CLI_INVALID_OPTION', '--expected-fingerprint is required and must be exact lowercase SHA-256.');
  }
  requireOnlyOptions(
    values,
    ALLOWLIST_REMOVE_OPTIONS,
    'remove action accepts only --action, --trust-root, --publisher-id, --key-id, --expected-fingerprint, and optional --output.',
  );
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
function parseAllowlistStateChange({ command, action, values, trustRoot, output }) {
  const { publisherId, keyId } = requiredAllowlistIdentity(values);
  requireOnlyOptions(
    values,
    ALLOWLIST_STATE_OPTIONS,
    `${action} action accepts only --action, --trust-root, --publisher-id, --key-id, and optional --output.`,
  );
  if (!values.has('publisher-id') || !values.has('key-id')) {
    fail('CLI_INVALID_OPTION', `${action} action requires --publisher-id and --key-id.`);
  }
  return Object.freeze({ command, action, publisherId, keyId, trustRoot, output });
}
const ALLOWLIST_ACTION_PARSERS = Object.freeze({
  list: parseAllowlistList,
  enroll: parseAllowlistEnroll,
  revoke: parseAllowlistStateChange,
  unrevoke: parseAllowlistStateChange,
  remove: parseAllowlistRemove,
});
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
  return ALLOWLIST_ACTION_PARSERS[action]({ command, action, values, trustRoot, output });
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
function isHelpRequest(argv) {
  return argv.length === 0 || ['help', '--help', '-h'].includes(argv[0]);
}
const COMMAND_PARSERS = Object.freeze({
  engines: ({ command, positionals, output }) => parseEngines(command, positionals, output),
  inspect: ({ command, positionals, flags, output }) => parseInspect(command, positionals, flags, output),
  'fast-web-view': ({ command, positionals, output }) => parseFastWebView(command, positionals, output),
  'accessibility-review': ({ command, positionals, output }) => parseAccessibilityReview(command, positionals, output),
  'accessibility-metadata': ({ command, positionals, values, output }) => parseAccessibilityMetadata(command, positionals, values, output),
  'aec-batch-link': ({ command, positionals, values, output }) => parseAecBatchLink(command, positionals, values, output),
  'signature-review': ({ command, positionals, output }) => parseSignatureReview(command, positionals, output),
  'compare-content': ({ command, positionals, values, output }) => parseContentComparison(command, positionals, values, output),
  'professional-capability': ({ command, positionals, values, output }) => parseProfessionalCapability(command, positionals, values, output),
  'create-blank': ({ command, positionals, values, output }) => parseCreateBlank(command, positionals, values, output),
  'convert-local': ({ command, positionals, output }) => parseLocalConversion(command, positionals, output),
  'convert-office-local': ({ command, positionals, output }) => parseOfficeLocalConversion(command, positionals, output),
  'convert-html-local': ({ command, positionals, output }) => parseHtmlConversion(command, positionals, output),
  'convert-postscript-local': ({ command, positionals, output }) => parsePostscriptConversion(command, positionals, output),
  'create-cad-pdf-local': ({ command, positionals, output }) => parseCadPdfCreation(command, positionals, output),
  'print-to-pdf-local': ({ command, positionals, output }) => parsePrintToPdf(command, positionals, output),
  'export-structured-local': ({ command, positionals, values, output }) => parseStructuredExport(command, positionals, values, output),
  'optimize-compress-local': ({ command, positionals, output }) => parseOptimizeCompress(command, positionals, output),
  'export-page-png-local': ({ command, positionals, values, output }) => parsePagePngExport(command, positionals, values, output),
  text: ({ command, positionals, values, output }) => parseText(command, positionals, values, output),
  'export-ooxml': ({ command, positionals, values, output }) => parseOoxmlExport(command, positionals, values, output),
  ocr: ({ command, positionals, values, output }) => parseOcr(command, positionals, values, output),
  'ocr-layout': ({ command, positionals, values, flags, output }) => parseOcrLayout(command, positionals, values, flags, output),
  'ocr-batch': ({ command, positionals, values }) => parseOcrBatch(command, positionals, values),
  'watch-ocr': ({ command, positionals, values, flags }) => parseWatchOcr(command, positionals, values, flags),
  'text-reflow': ({ command, positionals, values, output }) => parseTextReflow(command, positionals, values, output),
  'layer-defaults': ({ command, positionals, values, output }) => parseLayerDefaults(command, positionals, values, output),
  'signing-identities': ({ command, positionals, output }) => parseSigningIdentities(command, positionals, output),
  'scanner-discovery': ({ command, positionals, output }) => parseScannerDiscovery(command, positionals, output),
  'scan-append': ({ command, positionals, values, output }) => parseScanAppend(command, positionals, values, output),
  'acroform-choice': ({ command, positionals, values, output }) => parseAcroFormChoice(command, positionals, values, output),
  'bates-numbering': ({ command, positionals, values, output }) => parseBatesNumbering(command, positionals, values, output),
  'page-transition': ({ command, positionals, values, output }) => parsePageTransition(command, positionals, values, output),
  'certificate-sign': ({ command, positionals, values, flags, output }) => parseCertificateSign(command, positionals, values, flags, output),
  'sanitize-hidden-data': ({ command, positionals, output }) => parseHiddenDataSanitization(command, positionals, output),
  'add-checkbox': ({ command, positionals, values, output }) => parseAcroFormCheckbox(command, positionals, values, output),
  'add-radio-group': ({ command, positionals, values, output }) => parseAcroFormRadio(command, positionals, values, output),
  'acroform-text-field': ({ command, positionals, values, output }) => parseAcroFormTextField(command, positionals, values, output),
  'acroform-signature-field': ({ command, positionals, values, output }) => parseAcroFormSignatureField(command, positionals, values, output),
  'aec-measurement-legend': ({ command, positionals, values, output }) => parseAecMeasurementLegend(command, positionals, values, output),
  'tagged-remediation': ({ command, positionals, values, output }) => parseTaggedRemediation(command, positionals, values, output),
  'insert-jpeg': ({ command, positionals, values, output }) => parseJpegImage(command, positionals, values, output),
  'replace-jpeg': ({ command, positionals, values, output }) => parseJpegImageReplacement(command, positionals, values, output),
  'page-labels': ({ command, positionals, values, output }) => parsePageLabels(command, positionals, values, output),
  'advanced-search': ({ command, positionals, values, flags, output }) => parseAdvancedSearch(command, positionals, values, flags, output),
  'specialist-content': ({ command, positionals }) => parseSpecialistContent(command, positionals),
  'redact-pages': ({ command, positionals, values, output }) => parseFullPageRedactionBatch(command, positionals, values, output),
  'printer-marks': ({ command, positionals, values, output }) => parsePrinterMarks(command, positionals, values, output),
  'page-background': ({ command, positionals, values, output }) => parsePageBackground(command, positionals, values, output),
  'page-watermark': ({ command, positionals, values, output }) => parsePageWatermark(command, positionals, values, output),
  'snapshot-region': ({ command, positionals, values, output }) => parseSnapshotRegion(command, positionals, values, output),
  'admin.plugin-allowlist': ({ command, positionals, values }) => parseAdminPluginAllowlist(command, positionals, values),
  'admin.plugin-package': ({ command, positionals, values }) => parseAdminPluginPackage(command, positionals, values),
  'admin.policy-configuration': ({ command, positionals, values, output }) => parseAdminPolicyConfiguration(command, positionals, values, output),
  'admin.audit-telemetry': ({ command, positionals, values, output }) => parseAdminAuditTelemetry(command, positionals, values, output),
});
export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    fail('CLI_INVALID_ARGUMENTS', 'CLI arguments must be strings.');
  }
  if (isHelpRequest(argv)) return Object.freeze({ command: 'help' });
  const command = argv[0];
  const { values, flags, positionals } = parsedTokens(command, argv.slice(1));
  const output = values.has('output') ? boundedPath(values.get('output'), 'Output') : null;
  const context = { command, positionals, values, flags, output };
  if (Object.hasOwn(COMMAND_PARSERS, command)) return COMMAND_PARSERS[command](context);
  if (command.startsWith('automation-')) return parseAutomation(command, positionals, values, output);
  return parsePrepress(command, positionals, values, output);
}
