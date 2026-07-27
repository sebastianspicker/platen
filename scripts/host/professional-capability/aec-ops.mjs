import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import { opAecMeasurement } from './real-ops.mjs';
import { writeIncrementalPdfBatchGoToLinks } from '../pdf-incremental-goto-link-writer.mjs';
import { INCREMENTAL_BATCH_LINK_PROFILE } from '../pdf-incremental-batch-link-contract.mjs';
import { buildClassicPassivePdf } from './classic-structure-pdf.mjs';

const FAMILY = 'aec';
const FT_TO_M = 0.3048;

function digest(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Drawing measurement — real AEC measure dictionary path. */
export function aecMeasurement(ctx = {}) {
  return opAecMeasurement(ctx);
}

/** Scale calibration: known length ↔ PDF points → metersPerPdfPoint. */
export function aecScaleCalibration(ctx = {}) {
  const known = Number(ctx.knownLength ?? 1);
  const pdfPoints = Number(ctx.pdfPoints ?? 72);
  const unit = requireString(ctx.unit ?? 'ft', 'unit', { min: 1, max: 16 });
  if (!(known > 0) || !(pdfPoints > 0)) {
    fail('INVALID_CALIBRATION', 'Positive known length and pdf points required.', 400);
  }
  if (pdfPoints > 1_000_000) fail('INVALID_CALIBRATION', 'pdfPoints out of range.', 400);
  const unitToMeters = unit === 'm' || unit === 'meter' || unit === 'metres' ? 1
    : unit === 'mm' ? 0.001
    : unit === 'in' || unit === 'inch' ? 0.0254
    : FT_TO_M;
  const metersPerPdfPoint = (known * unitToMeters) / pdfPoints;
  const calibrationId = digest([String(known), String(pdfPoints), unit]).slice(0, 24);
  const pdf = createTextPdf({
    text: `Scale calibration\nid=${calibrationId}\nknown=${known} ${unit}\npdfPoints=${pdfPoints}\nm/pt=${metersPerPdfPoint}`,
    title: 'AEC scale calibration',
  });
  return result('aec.scale-calibration', {
    familyId: FAMILY,
    method: 'local-scale-calibration',
    knownLength: { value: known, unit },
    pdfPoints,
    metersPerPdfPoint,
    calibrationId,
    pdf,
    outputSha256: sha256(pdf),
  });
}

/** Quantity takeoff from real measurement path. */
export function aecTakeoff(ctx = {}) {
  const measured = opAecMeasurement(ctx);
  if (!measured?.pdf || !Number.isFinite(measured.siValue)) {
    fail('TAKEOFF_MEASURE_FAILED', 'Takeoff requires a successful measurement.', 502);
  }
  const lineItems = Array.isArray(ctx.lineItems)
    ? ctx.lineItems.slice(0, 100)
    : [{ id: 'item-1', quantity: measured.siValue, unit: measured.siUnit, kind: measured.kind }];
  const totalSi = lineItems.reduce((acc, item) => acc + (Number(item.quantity) || 0), 0);
  return result('aec.takeoff', {
    familyId: FAMILY,
    method: 'local-aec-takeoff-from-measurement',
    measurementSha256: measured.outputSha256,
    siValue: measured.siValue,
    siUnit: measured.siUnit,
    quantity: measured.siValue,
    totalSi,
    lineItems,
    lineItemCount: lineItems.length,
    pdf: measured.pdf,
    proof: measured.proof,
    bytes: measured.bytes,
  });
}

/** Batch same-document GoTo links via production batch writer (real /Annots /Subtype /Link). */
export function aecBatchLink(ctx = {}) {
  const raw = Array.isArray(ctx.links) ? ctx.links : [
    { fromPage: 1, toPage: 2, label: 'Detail' },
    { fromPage: 2, toPage: 1, label: 'Back' },
  ];
  if (raw.length === 0) fail('INVALID_LINKS', 'At least one link is required.', 400);
  const links = raw.slice(0, 50).map((link, index) => {
    const fromPage = Number.isSafeInteger(link.fromPage) ? link.fromPage : index + 1;
    const toPage = Number.isSafeInteger(link.toPage) ? link.toPage : Math.max(1, fromPage === 1 ? 2 : 1);
    if (fromPage < 1 || toPage < 1) fail('INVALID_LINKS', 'Page numbers must be ≥ 1.', 400);
    const label = requireString(String(link.label ?? `Link ${index + 1}`), 'link.label', { min: 1, max: 80 });
    const y = 700 - index * 28;
    return Object.freeze({
      fromPage,
      toPage,
      label,
      index,
      rect: Object.freeze({
        left: 72,
        bottom: y,
        right: 220,
        top: y + 24,
      }),
    });
  });
  const pageCount = Math.max(2, ...links.flatMap((l) => [l.fromPage, l.toPage]));
  const source = ctx.linkSourcePdf
    ? requireBytes(ctx.linkSourcePdf, 'linkSourcePdf')
    : buildClassicPassivePdf({ pages: pageCount });
  let written;
  try {
    written = writeIncrementalPdfBatchGoToLinks(source, {
      profile: INCREMENTAL_BATCH_LINK_PROFILE,
      links: links.map((l) => ({
        sourcePage: l.fromPage,
        targetPage: l.toPage,
        rect: l.rect,
      })),
    });
  } catch (error) {
    fail(error?.code || 'BATCH_LINK_WRITE_FAILED', error?.message || 'Batch GoTo link write failed.', 502);
  }
  const latin1 = written.bytes.toString('latin1');
  if (!latin1.includes('/Subtype /Link') && !latin1.includes('/Subtype/Link')) {
    fail('BATCH_LINK_ANNOT_MISSING', 'Batch link writer did not emit /Subtype /Link.', 502);
  }
  if (!latin1.includes('/Annots')) {
    fail('BATCH_LINK_ANNOTS_MISSING', 'Batch link writer did not emit /Annots.', 502);
  }
  const linkHits = (latin1.match(/\/Subtype\s*\/Link/g) ?? []).length;
  if (linkHits < links.length) {
    fail('BATCH_LINK_COUNT_LOW', `Expected ≥${links.length} Link subtypes, found ${linkHits}.`, 502);
  }
  return result('aec.batch-link', {
    familyId: FAMILY,
    method: 'local-aec-batch-goto-links',
    links,
    count: links.length,
    linkHits,
    linkDigest: digest(links.map((l) => `${l.fromPage}:${l.toPage}:${l.label}`)).slice(0, 32),
    sourceSha256: sha256(source),
    outputSha256: sha256(written.bytes),
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    applied: true,
  });
}

/** Offline project workspace manifest. */
export function aecOfflineProjects(ctx = {}) {
  const name = requireString(ctx.name ?? 'Project A', 'name', { min: 1, max: 80 });
  const sheets = Number.isSafeInteger(ctx.sheets) && ctx.sheets > 0 ? Math.min(ctx.sheets, 10_000) : 1;
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Offline projects cannot use network.', 403);
  const project = Object.freeze({
    id: digest([name, String(sheets)]).slice(0, 24),
    name,
    localOnly: true,
    sheets,
    status: 'offline-ready',
  });
  const pdf = createTextPdf({
    text: `Offline project\n${project.name}\nid=${project.id}\nsheets=${sheets}`,
    title: project.name,
  });
  return result('aec.offline-projects', {
    familyId: FAMILY,
    method: 'local-offline-project',
    project,
    pdf,
    outputSha256: sha256(pdf),
  });
}

/** Collaborative review session (local-only participants). */
export function aecCollaborativeReviewSessions(ctx = {}) {
  const participants = Array.isArray(ctx.participants)
    ? ctx.participants.map((p) => requireString(String(p), 'participant', { min: 1, max: 64 })).slice(0, 50)
    : ['a', 'b'];
  if (participants.length < 1) fail('INVALID_SESSION', 'At least one participant required.', 400);
  if (ctx.remote === true) fail('REMOTE_SESSION_FORBIDDEN', 'Remote sessions require adapter.', 403);
  const session = Object.freeze({
    id: digest(['session', ...participants]).slice(0, 24),
    participants,
    mode: 'offline-local',
    participantCount: participants.length,
  });
  return result('aec.collaborative-review-sessions', {
    familyId: FAMILY,
    method: 'local-collab-review-session',
    session,
    sessionDigest: digest([session.id, String(session.participantCount)]),
  });
}

/** Measurement toolset catalog with SI unit map. */
export function aecMeasurementToolset(ctx = {}) {
  const enabled = Array.isArray(ctx.tools) ? ctx.tools : null;
  const catalog = [
    { id: 'distance', siUnit: 'm', kind: 'linear' },
    { id: 'area', siUnit: 'm2', kind: 'area' },
    { id: 'perimeter', siUnit: 'm', kind: 'linear' },
    { id: 'count', siUnit: '1', kind: 'count' },
  ];
  const tools = enabled
    ? catalog.filter((t) => enabled.includes(t.id))
    : catalog;
  if (tools.length === 0) fail('EMPTY_TOOLSET', 'No measurement tools selected.', 400);
  return result('aec.measurement-toolset', {
    familyId: FAMILY,
    method: 'local-measurement-toolset-catalog',
    tools,
    toolCount: tools.length,
    siUnits: tools.map((t) => t.siUnit),
  });
}

/** Markup toolset definitions. */
export function aecMarkupToolsets(ctx = {}) {
  const toolsets = Array.isArray(ctx.toolsets)
    ? ctx.toolsets.slice(0, 20).map((ts, i) => {
      const id = requireString(String(ts.id ?? `set-${i + 1}`), 'toolset.id', { min: 1, max: 40 });
      const tools = Array.isArray(ts.tools) ? ts.tools.map(String).slice(0, 40) : ['pen', 'cloud', 'arrow'];
      return Object.freeze({ id, tools, toolCount: tools.length });
    })
    : [Object.freeze({ id: 'default', tools: ['pen', 'cloud', 'arrow'], toolCount: 3 })];
  const totalTools = toolsets.reduce((n, ts) => n + ts.toolCount, 0);
  return result('aec.markup-toolsets', {
    familyId: FAMILY,
    method: 'local-markup-toolset-registry',
    toolsets,
    setCount: toolsets.length,
    totalTools,
    registryDigest: digest(toolsets.map((ts) => `${ts.id}:${ts.tools.join(',')}`)).slice(0, 32),
  });
}

/** Markup inventory with type histogram. */
export function aecMarkupsList(ctx = {}) {
  const markups = (Array.isArray(ctx.markups) ? ctx.markups : [{ id: 'm1', type: 'cloud', page: 1 }])
    .slice(0, 200)
    .map((m, i) => Object.freeze({
      id: String(m.id ?? `m${i + 1}`),
      type: String(m.type ?? 'unknown'),
      page: Number.isSafeInteger(m.page) ? m.page : 1,
    }));
  const byType = Object.create(null);
  for (const m of markups) byType[m.type] = (byType[m.type] ?? 0) + 1;
  return result('aec.markups-list', {
    familyId: FAMILY,
    method: 'local-markup-list-digest',
    markups,
    count: markups.length,
    byType: Object.freeze({ ...byType }),
    inventoryDigest: digest(markups.map((m) => `${m.id}:${m.type}:${m.page}`)).slice(0, 32),
  });
}

/** Safe column formulas over finite numeric values. */
export function aecCustomColumnsFormulas(ctx = {}) {
  const formula = requireString(ctx.formula ?? 'sum', 'formula', { min: 1, max: 40 });
  const values = Array.isArray(ctx.values) ? ctx.values.map(Number) : [1, 2, 3];
  if (values.length === 0) fail('INVALID_VALUES', 'At least one value required.', 400);
  if (values.some((v) => !Number.isFinite(v))) fail('INVALID_VALUES', 'Finite values required.', 400);
  let computed;
  if (formula === 'sum') computed = values.reduce((a, b) => a + b, 0);
  else if (formula === 'avg' || formula === 'mean') computed = values.reduce((a, b) => a + b, 0) / values.length;
  else if (formula === 'count') computed = values.length;
  else if (formula === 'min') computed = Math.min(...values);
  else if (formula === 'max') computed = Math.max(...values);
  else fail('UNSUPPORTED_FORMULA', `Formula not allowed: ${formula}`, 400);
  return result('aec.custom-columns-formulas', {
    familyId: FAMILY,
    method: 'local-safe-column-formula',
    formula,
    values,
    result: computed,
    valueCount: values.length,
  });
}

/** Spaces / regions with area totals in SI. */
