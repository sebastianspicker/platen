import { deepFreeze, sha256 } from './accessibility-review-utils.mjs';

export const ACCESSIBILITY_COLOR_CONTRAST_PROFILE = 'local-accessibility-color-contrast-v1';
export const MAX_CONTRAST_PAGES = 200;
export const MAX_CONTRAST_SAMPLES_PER_PAGE = 256;
export const MAX_CONTRAST_GROUPS = 128;
export const CONTRAST_WARNING_CODES = Object.freeze([
  'gradient-background', 'ambiguous-background', 'transparency-present', 'renderer-incomplete',
]);

function invalid(message = 'Accessibility color-contrast options are invalid.') { const error = new Error(message); error.code = 'INVALID_ACCESSIBILITY_COLOR_CONTRAST_OPTIONS'; return error; }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw invalid(`${label} contains unsupported fields.`); return value; }
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} is out of bounds.`); return value; }
function digest(value, label) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw invalid(`${label} is invalid.`); return value; }
function mode(value) { if (value !== undefined && value !== 'all-pages') throw invalid('pages must be all-pages.'); return value ?? 'all-pages'; }

export function normalizeAccessibilityColorContrastRequest(value) {
  try {
    try { structuredClone(value); } catch { throw invalid('The request must be a data-only value.'); }
    const input = exact(value, ['profile', 'sourceSha256', 'pages'], 'Accessibility color-contrast request');
    if (input.profile !== ACCESSIBILITY_COLOR_CONTRAST_PROFILE) throw invalid();
    const sourceSha256 = digest(input.sourceSha256, 'sourceSha256');
    const pages = mode(input.pages);
    return deepFreeze({ profile: ACCESSIBILITY_COLOR_CONTRAST_PROFILE, sourceSha256, pages });
  } catch (error) { if (error?.code === 'INVALID_ACCESSIBILITY_COLOR_CONTRAST_OPTIONS') throw error; throw invalid(); }
}

export function validateContrastEvidence(value, { sourceSha256, page } = {}) {
  try {
    try { structuredClone(value); } catch { throw invalid('Renderer evidence must be data-only.'); }
    const input = exact(value, ['renderer', 'sourceSha256', 'page', 'width', 'height', 'colorSpace', 'samples', 'colorOnlyGroups', 'warnings'], 'Contrast renderer evidence');
    if (input.renderer !== 'poppler-raster-evidence-v1' || input.sourceSha256 !== sourceSha256 || input.page !== page) throw invalid('Renderer evidence is not source-bound.');
    integer(input.width, 'width', 1, 8192); integer(input.height, 'height', 1, 8192);
    if (input.colorSpace !== 'sRGB') throw invalid('Only explicit sRGB renderer evidence is supported.');
    if (!Array.isArray(input.samples) || input.samples.length > MAX_CONTRAST_SAMPLES_PER_PAGE) throw invalid('Renderer samples exceed the fixed bound.');
    const samples = input.samples.map((sample) => {
      const item = exact(sample, ['id', 'bounds', 'foreground', 'background', 'pairing', 'confidence', 'colorOnlyGroup'], 'Contrast sample');
      if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(item.id)) throw invalid('Contrast sample id is invalid.');
      const bounds = exact(item.bounds, ['x', 'y', 'width', 'height'], 'Contrast sample bounds');
      for (const [key, value] of Object.entries(bounds)) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Math.max(input.width, input.height)) throw invalid('Contrast sample bounds are invalid.'); }
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > input.width || bounds.y + bounds.height > input.height) throw invalid('Contrast sample bounds are outside the rendered page.');
      const color = (candidate, label) => { const c = exact(candidate, ['r', 'g', 'b', 'a'], label); for (const key of ['r', 'g', 'b', 'a']) if (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || c[key] < 0 || c[key] > 1) throw invalid(`${label} is invalid.`); return c; };
      if (!['trusted-text-background', 'trusted-raster-region'].includes(item.pairing) || !['high', 'medium', 'low'].includes(item.confidence)) throw invalid('Contrast sample pairing or confidence is invalid.');
      if (item.colorOnlyGroup !== null && (typeof item.colorOnlyGroup !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(item.colorOnlyGroup))) throw invalid('Color-only group is invalid.');
      return { id: item.id, bounds, foreground: color(item.foreground, 'Foreground color'), background: color(item.background, 'Background color'), pairing: item.pairing, confidence: item.confidence, colorOnlyGroup: item.colorOnlyGroup };
    });
    const ids = new Set(); for (const sample of samples) { if (ids.has(sample.id)) throw invalid('Contrast sample ids must be unique.'); ids.add(sample.id); }
    if (!Array.isArray(input.colorOnlyGroups) || input.colorOnlyGroups.length > MAX_CONTRAST_GROUPS) throw invalid('Color-only groups exceed the fixed bound.');
    const groups = input.colorOnlyGroups.map((group) => { const item = exact(group, ['id', 'sampleIds', 'nonColorCue'], 'Color-only group'); if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(item.id) || !Array.isArray(item.sampleIds) || item.sampleIds.length < 2 || item.sampleIds.length > MAX_CONTRAST_SAMPLES_PER_PAGE || typeof item.nonColorCue !== 'boolean') throw invalid('Color-only group is invalid.'); if (new Set(item.sampleIds).size !== item.sampleIds.length || item.sampleIds.some((id) => !ids.has(id))) throw invalid('Color-only group references an unknown sample.'); return item; });
    const groupIds = new Set(); const memberships = new Map(); for (const group of groups) { if (groupIds.has(group.id)) throw invalid('Color-only group ids must be unique.'); groupIds.add(group.id); for (const id of group.sampleIds) { if (memberships.has(id)) throw invalid('A sample cannot belong to multiple color-only groups.'); memberships.set(id, group.id); } }
    for (const sample of samples) { const declared = sample.colorOnlyGroup; if (declared !== null && (!groupIds.has(declared) || memberships.get(sample.id) !== declared)) throw invalid('Sample color-only group membership is inconsistent.'); }
    for (const group of groups) for (const id of group.sampleIds) { if (samples.find((sample) => sample.id === id)?.colorOnlyGroup !== group.id) throw invalid('Color-only group membership must be declared by each sample.'); }
    if (!Array.isArray(input.warnings) || input.warnings.length > 32 || input.warnings.some((warning) => !CONTRAST_WARNING_CODES.includes(warning))) throw invalid('Renderer warnings are invalid.');
    return deepFreeze({ renderer: input.renderer, sourceSha256, page, width: input.width, height: input.height, colorSpace: input.colorSpace, samples, colorOnlyGroups: groups, warnings: [...input.warnings] });
  } catch (error) { if (error?.code === 'INVALID_ACCESSIBILITY_COLOR_CONTRAST_OPTIONS') throw error; throw invalid(); }
}

export function contrastReportHash(report) { const { reportSha256: _ignored, ...unsigned } = report; return sha256(unsigned); }

export const normalizeAccessibilityColorContrastReviewRequest = normalizeAccessibilityColorContrastRequest;
