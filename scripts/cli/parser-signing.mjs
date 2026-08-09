import { exactPositionals, fail, boundedPath, positiveInteger } from './parser-foundation.mjs';
export function parseSigningIdentities(command, positionals, output) { exactPositionals(positionals, 0); return Object.freeze({ command, output }); }
export function parseHiddenDataSanitization(command, positionals, output) { const [input] = exactPositionals(positionals, 1); if (!output) fail('CLI_INVALID_OPTION', 'sanitize-hidden-data requires --output.'); return Object.freeze({ command, input, output: boundedPath(output, 'Output') }); }
function boundedText(value, label) { if (typeof value !== 'string' || value !== value.normalize('NFC') || [...value].length < 1 || [...value].length > 127 || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) fail('CLI_INVALID_OPTION', `${label} must be bounded NFC text.`); return value; }
function parseRect(value) { const parts = String(value ?? '').split(','); if (parts.length !== 4 || parts.some((part) => !part.trim() || !Number.isFinite(Number(part)))) fail('CLI_INVALID_OPTION', '--rect must contain four comma-separated coordinates: X,Y,W,H.'); const [x, y, width, height] = parts.map(Number); if ([x, y, width, height].some((v) => Object.is(v, -0) || Math.abs(v) > 1_000_000) || width <= 0 || height <= 0) fail('CLI_INVALID_OPTION', '--rect must be a positive bounded rectangle.'); return Object.freeze({ x, y, width, height }); }
function signatureRect(value) { const result = parseRect(value); if (Object.values(result).some((number) => Math.round(number * 1_000_000) !== number * 1_000_000)) fail('CLI_INVALID_OPTION', '--rect must use at most six decimal places for signature-field preparation.'); return result; }
function pdfOutput(output, command) { if (!output || !/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', `${command} requires a .pdf --output.`); return boundedPath(output, 'Output'); }
export function parseAcroFormCheckbox(command, positionals, values, output) { const [input] = exactPositionals(positionals, 1); if (!values.has('field-name') || !values.has('page') || !values.has('rect')) fail('CLI_INVALID_OPTION', 'add-checkbox requires --field-name, --page, --rect, and --output.'); return Object.freeze({ command, input, fieldName: boundedText(values.get('field-name'), '--field-name'), page: positiveInteger(values.get('page'), '--page', 10000), rect: parseRect(values.get('rect')), output: pdfOutput(output, command) }); }
export function parseAcroFormRadio(command, positionals, values, output) { const [input] = exactPositionals(positionals, 1); if (!values.has('group-name') || !values.has('options')) fail('CLI_INVALID_OPTION', 'add-radio-group requires --group-name, --options, and --output.'); return Object.freeze({ command, input, groupName: boundedText(values.get('group-name'), '--group-name'), optionsPath: boundedPath(values.get('options'), 'Options'), output: pdfOutput(output, command) }); }
export function parseAcroFormTextField(command, positionals, values, output) { const [input] = exactPositionals(positionals, 1); if (!values.has('field') || !values.has('page') || !values.has('rect')) fail('CLI_INVALID_OPTION', 'acroform-text-field requires --field, --page, --rect, and --output.'); return Object.freeze({ command, input, fieldName: boundedText(values.get('field'), '--field'), page: positiveInteger(values.get('page'), '--page', 10000), rect: parseRect(values.get('rect')), output: pdfOutput(output, command) }); }
export function parseAcroFormSignatureField(command, positionals, values, output) { const [input] = exactPositionals(positionals, 1); if (!values.has('field') || !values.has('page') || !values.has('rect')) fail('CLI_INVALID_OPTION', 'acroform-signature-field requires --field, --page, --rect, and --output.'); return Object.freeze({ command, input, fieldName: boundedText(values.get('field'), '--field'), page: positiveInteger(values.get('page'), '--page', 10000), rect: signatureRect(values.get('rect')), output: pdfOutput(output, command) }); }
export function parseAecMeasurementLegend(command, positionals, values, output) { const [input] = exactPositionals(positionals, 1); if (!output) fail('CLI_INVALID_OPTION', 'aec-measurement-legend requires --output.'); const format = values.get('format') ?? 'json'; if (!['json', 'csv'].includes(format)) fail('CLI_INVALID_OPTION', '--format must be json or csv.'); if (!new RegExp(`\\.${format}$`, 'iu').test(output)) fail('CLI_INVALID_OPTION', `--output must use the .${format} extension.`); return Object.freeze({ command, input, format, output: boundedPath(output, 'Output') }); }
export function parseTaggedRemediation(command, positionals, values, output) { const [input] = exactPositionals(positionals, 1); if (!output || !values.has('plan')) fail('CLI_INVALID_OPTION', 'tagged-remediation requires --plan and --output.'); return Object.freeze({ command, input, planPath: boundedPath(values.get('plan'), 'Plan'), output: boundedPath(output, 'Output') }); }
export function parseJpegImage(command, positionals, values, output) {
  const [input, image] = exactPositionals(positionals, 2);
  if (!/\.jpe?g$/iu.test(image)) fail('CLI_INVALID_OPTION', 'insert-jpeg accepts .jpg or .jpeg image input only.');
  if (!output || !values.has('page') || !values.has('rect')) fail('CLI_INVALID_OPTION', 'insert-jpeg requires --page, --rect, and --output.');
  const page = positiveInteger(values.get('page'), '--page', 10_000);
  const parts = String(values.get('rect')).split(',');
  if (parts.length !== 4 || parts.some((part) => !part.trim() || !Number.isFinite(Number(part)))) fail('CLI_INVALID_OPTION', '--rect must contain four comma-separated coordinates: X,Y,W,H.');
  const [x, y, width, height] = parts.map(Number);
  if ([x, y, width, height].some((value) => Object.is(value, -0) || value < -1_000_000 || value > 1_000_000) || width <= 0 || height <= 0) fail('CLI_INVALID_OPTION', '--rect must be a positive bounded rectangle.');
  return Object.freeze({ command, input, image, page, rect: Object.freeze({ x, y, width, height }), output: boundedPath(output, 'Output') });
}
export function parseJpegImageReplacement(command, positionals, values, output) {
  const [input, image] = exactPositionals(positionals, 2);
  if (!/\.jpe?g$/iu.test(image)) fail('CLI_INVALID_OPTION', 'replace-jpeg accepts .jpg or .jpeg image input only.');
  if (!output || !values.has('page') || !values.has('resource-name')) fail('CLI_INVALID_OPTION', 'replace-jpeg requires --page, --resource-name, and --output.');
  const resourceName = values.get('resource-name'); if (typeof resourceName !== 'string' || !/^[A-Za-z0-9_.-]{1,127}$/u.test(resourceName)) fail('CLI_INVALID_OPTION', '--resource-name must be a bounded PDF resource name.');
  return Object.freeze({ command, input, image, page: positiveInteger(values.get('page'), '--page', 10_000), resourceName, output: boundedPath(output, 'Output') });
}
export function parsePageLabels(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output || !values.has('ranges')) fail('CLI_INVALID_OPTION', 'page-labels requires --ranges and --output.');
  return Object.freeze({ command, input, rangesPath: boundedPath(values.get('ranges'), 'Ranges'), output: boundedPath(output, 'Output') });
}
export function parseAdvancedSearch(command, positionals, values, flags, output) {
  const [input] = exactPositionals(positionals, 1); if (!output || !values.has('query')) fail('CLI_INVALID_OPTION', 'advanced-search requires --query and --output.');
  const query = values.get('query'); if (typeof query !== 'string' || query !== query.normalize('NFC') || [...query].length < 1 || [...query].length > 128 || [...query].some((point) => /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point))) fail('CLI_INVALID_OPTION', '--query must be bounded NFC text without controls.');
  const mode = values.get('mode') ?? 'literal'; if (!['literal', 'wildcard'].includes(mode) || mode === 'wildcard' && [...query].every((point) => point === '*' || point === '?')) fail('CLI_INVALID_OPTION', '--mode or --query is invalid.');
  let context = 32; if (values.has('context')) { if (!/^\d+$/u.test(String(values.get('context'))) || Number(values.get('context')) > 200) fail('CLI_INVALID_OPTION', '--context must be from 0 through 200.'); context = Number(values.get('context')); } const maxResults = values.has('max-results') ? positiveInteger(values.get('max-results'), '--max-results', 1_000) : 100;
  return Object.freeze({ command, input, query, mode, caseSensitive: flags.has('case-sensitive'), wholeWord: flags.has('whole-word'), context, maxResults, output: boundedPath(output, 'Output') });
}
export function parseCertificateSign(command, positionals, values, flags, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output) fail('CLI_INVALID_OPTION', 'certificate-sign requires --output.');
  if (!flags.has('consent')) fail('CLI_INVALID_OPTION', 'certificate-sign requires explicit --consent for this operation.');
  const certificateSha256 = values.get('certificate-sha256');
  if (!/^[0-9a-f]{64}$/u.test(certificateSha256 ?? '')) fail('CLI_INVALID_OPTION', '--certificate-sha256 must be a lowercase SHA-256 digest.');
  if (!values.has('field-name')) fail('CLI_INVALID_OPTION', 'certificate-sign requires --field-name.');
  const page = positiveInteger(values.get('page') ?? '1', '--page', 10_000);
  const fieldName = values.get('field-name');
  const reason = values.get('reason') ?? '';
  const location = values.get('location') ?? '';
  const contact = values.get('contact') ?? '';
  for (const [label, value, min, max] of [['field-name', fieldName, 1, 127], ['reason', reason, 0, 255], ['location', location, 0, 255], ['contact', contact, 0, 255]]) {
    if (typeof value !== 'string' || value !== value.normalize('NFC') || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || value.includes('\ufffd')) fail('CLI_INVALID_OPTION', `--${label} must be bounded NFC text.`);
  }
  const placeholderBytes = values.has('placeholder-bytes') ? positiveInteger(values.get('placeholder-bytes'), '--placeholder-bytes', 262_144) : 16_384;
  if (placeholderBytes < 4_096) fail('CLI_INVALID_OPTION', '--placeholder-bytes must be from 4096 through 262144.');
  return Object.freeze({ command, input, output: boundedPath(output, 'Output'), certificateSha256, page, fieldName, reason, location, contact, placeholderBytes, consent: true });
}
