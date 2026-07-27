import { boundedPath, exactPositionals, fail, positiveInteger } from './parser-foundation.mjs';
import { normalizeSnapshotRegion } from '../../src/core/snapshot-output.js';
import { normalizeIncrementalAccessibilityMetadata } from '../host/pdf-incremental-accessibility-metadata-contract.mjs';
function text(value, label, allowEmpty = false) { if (typeof value !== 'string' || (!allowEmpty && value.length < 1) || value.length > 127 || value !== value.normalize('NFC') || !/^[\x20-\x7E]*$/u.test(value)) fail('CLI_INVALID_OPTION', `${label} must be bounded printable NFC text.`); return value; }
function batesText(value, label) { if (typeof value !== 'string' || value.length > 64 || value !== value.normalize('NFC') || !/^[\x20-\x7E]*$/u.test(value)) fail('CLI_INVALID_OPTION', `${label} must be bounded printable ASCII text.`); return value; }
function rect(value) { const parts = String(value ?? '').split(','); if (parts.length !== 4 || parts.some((part) => !Number.isFinite(Number(part)))) fail('CLI_INVALID_OPTION', '--rect must contain X,Y,W,H.'); const [x, y, width, height] = parts.map(Number); if (width <= 0 || height <= 0 || [x, y, width, height].some((entry) => Math.abs(entry) > 1_000_000)) fail('CLI_INVALID_OPTION', '--rect is outside bounds.'); return Object.freeze({ x, y, width, height }); }
export function parseAccessibilityReview(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output) fail('CLI_INVALID_OPTION', 'The accessibility-review command requires --output.');
  return Object.freeze({ command, input, output });
}
export function parseAccessibilityMetadata(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output) fail('CLI_INVALID_OPTION', 'The accessibility-metadata command requires --output.');
  if (!values.has('language') || !values.has('title')) {
    fail('CLI_INVALID_OPTION', 'The accessibility-metadata command requires --language and --title.');
  }
  let metadata;
  try {
    metadata = normalizeIncrementalAccessibilityMetadata({
      language: values.get('language'),
      title: values.get('title'),
    });
  } catch {
    fail('CLI_INVALID_OPTION', 'The accessibility metadata language or title is outside the bounded canonical contract.');
  }
  return Object.freeze({ command, input, output, ...metadata });
}
export function parseAecBatchLink(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!values.has('links') || !output) fail('CLI_INVALID_OPTION', 'aec-batch-link requires --links LINKS.json and --output OUTPUT.pdf.');
  const links = boundedPath(values.get('links'), 'Links');
  if (!/\.json$/iu.test(links)) fail('CLI_INVALID_OPTION', '--links must use a .json file.');
  if (!/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', 'aec-batch-link output must use a .pdf file.');
  return Object.freeze({ command, input, links, output });
}
export function parseAcroFormChoice(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1); if (!values.has('field') || !values.has('page') || !values.has('rect') || !values.has('options') || !output) fail('CLI_INVALID_OPTION', 'acroform-choice requires --field, --page, --rect, --options, and --output.');
  return Object.freeze({ command, input, fieldName: text(values.get('field'), '--field'), page: positiveInteger(values.get('page'), '--page', 10_000), rect: rect(values.get('rect')), optionsPath: boundedPath(values.get('options'), 'Options'), output: boundedPath(output, 'Output') });
}
export function parseBatesNumbering(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1); if (!output || !values.has('pages')) fail('CLI_INVALID_OPTION', 'bates-numbering requires --pages and --output.');
  const pages = []; let previous = 0;
  for (const part of String(values.get('pages')).split(',')) { const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim()); if (!match) fail('CLI_INVALID_OPTION', '--pages must contain bounded ranges such as 1,3-5.'); const first = Number(match[1]); const last = Number(match[2] ?? match[1]); if (first < 1 || last < first || last > 500 || last - first + 1 > 500 || first <= previous || pages.length + last - first + 1 > 500) fail('CLI_INVALID_OPTION', '--pages must be ascending, unique, and bounded.'); for (let page = first; page <= last; page += 1) pages.push(page); previous = last; }
  const start = values.has('start') ? Number(values.get('start')) : 0; const margin = values.has('margin') ? Number(values.get('margin')) : 12; const fontSize = values.has('font-size') ? Number(values.get('font-size')) : 10; const position = values.get('position') ?? 'bottom-left';
  if (!Number.isSafeInteger(start) || start < 0 || start + pages.length - 1 > 999_999_999 || !Number.isFinite(margin) || margin < 0 || margin > 1_000_000 || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 200 || !['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(position)) fail('CLI_INVALID_OPTION', 'Bates numeric or position options are out of bounds.');
  return Object.freeze({ command, input, pages: Object.freeze(pages), start, prefix: batesText(values.get('prefix') ?? '', '--prefix'), suffix: batesText(values.get('suffix') ?? '', '--suffix'), padding: values.has('padding') ? positiveInteger(values.get('padding'), '--padding', 12) : 6, position, margin, fontSize, output: boundedPath(output, 'Output') });
}

export function parsePageTransition(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output || !values.has('pages') || !values.has('duration')) fail('CLI_INVALID_OPTION', 'page-transition requires --pages, --duration, and --output.');
  const pages = []; let previous = 0;
  for (const part of String(values.get('pages')).split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    if (!match) fail('CLI_INVALID_OPTION', '--pages must contain bounded ascending ranges such as 1,3-5.');
    const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > 100 || first <= previous || pages.length + last - first + 1 > 100) fail('CLI_INVALID_OPTION', '--pages must be ascending, unique, and bounded to 100 pages.');
    for (let page = first; page <= last; page += 1) pages.push(page);
    previous = last;
  }
  const duration = Number(values.get('duration'));
  if (!Number.isFinite(duration) || duration < 0 || duration > 60 || duration * 1000 !== Math.round(duration * 1000)) fail('CLI_INVALID_OPTION', '--duration must be a finite number from 0 through 60 seconds at millisecond precision.');
  return Object.freeze({ command, input, pages: Object.freeze(pages), duration, output: boundedPath(output, 'Output') });
}

export function parseSnapshotRegion(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output || !values.has('page') || !values.has('region')) {
    fail('CLI_INVALID_OPTION', 'snapshot-region requires --page, --region, and --output.');
  }
  const page = positiveInteger(values.get('page'), '--page', 10_000);
  const dpi = values.has('dpi') ? positiveInteger(values.get('dpi'), '--dpi', 240) : 192;
  if (dpi < 36) fail('CLI_INVALID_OPTION', '--dpi must be from 36 through 240.');
  const parts = String(values.get('region')).split(',');
  if (parts.length !== 4 || parts.some((part) => !part.trim() || !Number.isFinite(Number(part)))) {
    fail('CLI_INVALID_OPTION', '--region must contain four comma-separated normalized numbers: X,Y,W,H.');
  }
  let region;
  try {
    region = normalizeSnapshotRegion(Object.fromEntries(['x', 'y', 'width', 'height'].map((key, index) => [key, Number(parts[index])] )));
  } catch {
    fail('CLI_INVALID_OPTION', '--region must be a positive normalized rectangle with at most six decimal places.');
  }
  if (!/\.png$/u.test(output)) fail('CLI_INVALID_OPTION', 'snapshot-region requires a .png --output.');
  return Object.freeze({ command, input, page, dpi, region, output: boundedPath(output, 'Output') });
}

const PACKAGE_ACTIONS = Object.freeze(['list', 'install', 'activate', 'rollback']);
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;

export function parseAdminPluginPackage(command, positionals, values) {
  exactPositionals(positionals, 0);
  const action = values.get('action');
  if (!action || !PACKAGE_ACTIONS.includes(action)) fail('CLI_INVALID_OPTION', '--action must be list, install, activate, or rollback.');
  if (!values.has('plugin-root') || !values.has('trust-root')) fail('CLI_INVALID_OPTION', 'admin.plugin-package requires explicit --plugin-root and --trust-root.');
  const pluginRoot = boundedPath(values.get('plugin-root'), 'Plugin root');
  const trustRoot = boundedPath(values.get('trust-root'), 'Trust root');
  const output = values.has('output') ? boundedPath(values.get('output'), 'Output') : null;
  const allowed = new Set(['action', 'plugin-root', 'trust-root', 'output']);
  if (action === 'list') {
    if ([...values.keys()].some((key) => !allowed.has(key))) fail('CLI_INVALID_OPTION', 'list only accepts --action, --plugin-root, --trust-root, and optional --output.');
    return Object.freeze({ command, action, pluginRoot, trustRoot, output });
  }
  if (action === 'install') {
    const packagePath = values.get('package');
    if (typeof packagePath !== 'string') fail('CLI_INVALID_OPTION', 'install requires --package.');
    if ([...values.keys()].some((key) => !new Set([...allowed, 'package']).has(key))) fail('CLI_INVALID_OPTION', 'install accepts only --action, --plugin-root, --trust-root, --package, and optional --output.');
    return Object.freeze({ command, action, pluginRoot, trustRoot, packagePath: boundedPath(packagePath, 'Package'), output });
  }
  const pluginId = values.get('plugin-id');
  if (typeof pluginId !== 'string' || !PLUGIN_ID.test(pluginId)) fail('CLI_INVALID_OPTION', `${action} requires a canonical --plugin-id.`);
  if ([...values.keys()].some((key) => !new Set([...allowed, 'plugin-id', ...(action === 'activate' ? ['version'] : [])]).has(key))) fail('CLI_INVALID_OPTION', `${action} has an unsupported option.`);
  const version = values.get('version');
  if (action === 'activate' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version ?? '')) fail('CLI_INVALID_OPTION', 'activate requires a canonical --version.');
  if (action === 'rollback' && version !== undefined) fail('CLI_INVALID_OPTION', 'rollback does not accept --version.');
  return Object.freeze({ command, action, pluginRoot, trustRoot, pluginId, version: version ?? null, output });
}
