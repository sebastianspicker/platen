import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';

export const PDF_ACROFORM_RADIO_PROFILE = 'local-pdf-acroform-radio-v1';
const MAX_SOURCE = 32 * 1024 * 1024; const MAX_PAGES = 10_000; const MAX_COORDINATE = 1_000_000;
function err(code, message) { const e = new Error(message); e.code = code; return e; }
function unsupported(message = 'The source PDF is outside the supported passive AcroForm radio subset.') { throw err('UNSUPPORTED_PDF_ACROFORM_RADIO_SOURCE', message); }
function invalid(message = 'The AcroForm radio request is invalid.') { throw err('INVALID_PDF_ACROFORM_RADIO', message); }
function outputInvalid() { throw err('INVALID_PDF_ACROFORM_RADIO_OUTPUT', 'The AcroForm radio output failed deterministic verification.'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function name(value) { return Object.freeze({ type: 'name', value }); } function num(value, raw) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), ...(raw ? { raw } : {}) }); }
function arr(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); } function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function ref(value) { return Object.freeze({ type: 'ref', object: value.object, generation: value.generation }); } function same(a, b) { return a?.object === b?.object && a?.generation === b?.generation; }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((k) => typeof k !== 'string')) invalid(); const d = Object.getOwnPropertyDescriptors(value); if (Object.keys(d).sort().join(',') !== [...keys].sort().join(',') || Object.values(d).some((x) => !Object.hasOwn(x, 'value') || x.enumerable !== true)) invalid(); }
function text(value, label) { if (typeof value !== 'string' || value.length < 1 || value.length > 127 || value !== value.normalize('NFC') || /[\u0000-\u001f\u007f\ufffd]/u.test(value) || /[\p{Cf}]/u.test(value)) invalid(`${label} is not canonical NFC text.`); return value; }
function rect(value) { exact(value, ['x', 'y', 'width', 'height']); const round = (v) => Math.round(v * 1e6) / 1e6; const out = { x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height) }; if (Object.values(out).some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) || out.width <= 0 || out.height <= 0) invalid('option rectangle is invalid.'); return Object.freeze(out); }
function normalize(source, request) { exact(request, ['profile', 'sourceSha256', 'groupName', 'options']);
if (request.profile !== PDF_ACROFORM_RADIO_PROFILE || !/^[0-9a-f]{64}$/u.test(request.sourceSha256) || digest(source) !== request.sourceSha256 || !Array.isArray(request.options) || request.options.length < 2 || request.options.length > 10) invalid();
const groupName = text(request.groupName, 'groupName');
const seen = new Set();
const rects = new Set();
const options = request.options.map((item) => { exact(item, ['label', 'page', 'rect']);
const label = text(item.label, 'option label');
if (seen.has(label)) invalid('radio option labels must be unique.');
seen.add(label);
if (!Number.isSafeInteger(item.page) || item.page < 1) invalid('radio option page is invalid.');
const box = rect(item.rect);
const key = `${item.page}:${box.x},${box.y},${box.width},${box.height}`;
if (rects.has(key)) invalid('radio option rectangles must be unique.');
rects.add(key);
return Object.freeze({ label, page: item.page, rect: box });
});
return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, groupName, options: Object.freeze(options) });
}
function admit(source) { let s;
try { s = parseClassicPdfStructure(source);
} catch { unsupported('Malformed classic PDF.');
} if (source.length < 32 || source.length > MAX_SOURCE || s.revisions.length !== 1 || s.revisions.some((r) => r.xrefKind === 'stream') || s.id || s.info) unsupported();
const c = pdfDictionary(resolveClassicPdfObject(s, s.root).value);
if (c.size !== 2 || c.get('Type')?.value !== 'Catalog' || c.get('Pages')?.type !== 'ref') unsupported();
const pages = [];
const seen = new Set();
const walk = (r, parent) => { const key = `${r.object}:${r.generation}`;
if (seen.has(key)) unsupported('Aliased radio page graph.');
seen.add(key);
const o = resolveClassicPdfObject(s, r);
if (o.stream) unsupported();
const v = pdfDictionary(o.value);
for (const k of v.keys()) if (['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'XFA'].includes(k)) unsupported('Active PDF structures are not admitted.');
if (v.get('Type')?.value === 'Pages') { if (v.size !== 3 || v.get('Kids')?.type !== 'array' || v.get('Count')?.value !== v.get('Kids').values.length) unsupported('Only a flat direct Pages tree is admitted.');
for (const child of v.get('Kids').values) { if (child.type !== 'ref') unsupported();
const cv = pdfDictionary(resolveClassicPdfObject(s, child).value);
if (cv.get('Type')?.value !== 'Page') unsupported();
walk(child, r);
} return;
} if (v.get('Type')?.value !== 'Page' || !same(v.get('Parent'), parent) || v.get('Resources')?.type !== 'dict' || v.has('Annots') || v.get('MediaBox')?.type !== 'array') unsupported();
pages.push({ ref: r, value: v });
};
walk(c.get('Pages'), null);
if (!pages.length || pages.length > MAX_PAGES) unsupported();
return Object.freeze({ structure: s, pages });
}
function box(value) { if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((v) => v.type !== 'number')) unsupported(); const [left, bottom, right, top] = value.values.map((v) => v.value); if (!(right > left && top > bottom)) unsupported(); return { left, bottom, right, top }; }
function stateName(label, index) { const base = `Opt${index + 1}`; return base; }
function appearance(option, on) { const r = option.rect; const cx = r.width / 2; const cy = r.height / 2; const radius = Math.min(r.width, r.height) * 0.38; const f = (v) => String(Math.round(v * 1e6) / 1e6); const k = 0.5522848; const circle = (rad) => `${f(cx + rad)} ${f(cy)} m\n${f(cx + rad)} ${f(cy + k * rad)} ${f(cx + k * rad)} ${f(cy + rad)} ${f(cx)} ${f(cy + rad)} c\n${f(cx - k * rad)} ${f(cy + rad)} ${f(cx - rad)} ${f(cy + k * rad)} ${f(cx - rad)} ${f(cy)} c\n${f(cx - rad)} ${f(cy - k * rad)} ${f(cx - k * rad)} ${f(cy - rad)} ${f(cx)} ${f(cy - rad)} c\n${f(cx + k * rad)} ${f(cy - rad)} ${f(cx + rad)} ${f(cy - k * rad)} ${f(cx + rad)} ${f(cy)} c`; const stream = Buffer.from(`q\n1 w\n${circle(radius)}\nS${on ? `\n${circle(radius * 0.45)}\nf` : ''}\nQ\n`, 'latin1'); return { value: dict([['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', num(1)], ['BBox', arr([num(0), num(0), num(r.width, String(r.width)), num(r.height, String(r.height))])]]), stream }; }
function build(source, normalized, admission) { const ids = normalized.options.map((_, i) => ({ off: pendingClassicObjectReference(`off${i}`), on: pendingClassicObjectReference(`on${i}`), widget: pendingClassicObjectReference(`widget${i}`) }));
const parentId = pendingClassicObjectReference('parent');
const acroId = pendingClassicObjectReference('acro');
const parentPage = new Map();
const additions = [];
const kids = [];
for (let i = 0;
i < normalized.options.length;
i += 1) { const option = normalized.options[i];
const page = admission.pages[option.page - 1];
if (!page) invalid('option page outside document.');
const crop = box(page.value.get('CropBox') ?? page.value.get('MediaBox'));
if (option.rect.x < crop.left || option.rect.y < crop.bottom || option.rect.x + option.rect.width > crop.right || option.rect.y + option.rect.height > crop.top) invalid('radio rectangle is outside CropBox.');
const state = stateName(option.label, i);
const off = appearance(option, false);
const on = appearance(option, true);
const ap = dict([['N', dict([['Off', ids[i].off], [state, ids[i].on]])]]);
const widget = dict([['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Btn')], ['F', num(4)], ['Parent', parentId], ['P', page.ref], ['Rect', arr([num(option.rect.x, String(option.rect.x)), num(option.rect.y, String(option.rect.y)), num(option.rect.x + option.rect.width, String(option.rect.x + option.rect.width)), num(option.rect.y + option.rect.height, String(option.rect.y + option.rect.height))])], ['AP', ap], ['AS', name('Off')]]);
kids.push(ids[i].widget);
additions.push({ id: `off${i}`, value: off.value, streamBytes: off.stream }, { id: `on${i}`, value: on.value, streamBytes: on.stream }, { id: `widget${i}`, value: widget });
(parentPage.get(option.page) ?? parentPage.set(option.page, []).get(option.page)).push(ids[i].widget);
}
  const parent = dict([['FT', name('Btn')], ['Ff', num(1 << 15 | 1 << 14)], ['T', pdfUtf16BeString(normalized.groupName)], ['Kids', arr(kids)], ['V', name('Off')]]);
  additions.push({ id: 'parent', value: parent });
  const acro = dict([['Fields', arr([parentId])]]);
  additions.push({ id: 'acro', value: acro });
  const updates = [{ reference: admission.structure.root, value: dict(new Map([...pdfDictionary(resolveClassicPdfObject(admission.structure, admission.structure.root).value), ['AcroForm', acroId]])) }];
  for (const [pageNumber, widgets] of parentPage) { const page = admission.pages[pageNumber - 1];
  const values = new Map(page.value);
  values.set('Annots', arr(widgets));
  updates.push({ reference: page.ref, value: dict(values) });
  } const tx = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates, additions, info: { kind: 'preserve' }, changingId: null });
  const bytes = Buffer.concat([source, tx.revision.bytes]);
  return { bytes, refs: { parent: tx.referencesById.parent, acro: tx.referencesById.acro, options: ids.map((id) => ({ off: tx.referencesById[`off${ids.indexOf(id)}`], on: tx.referencesById[`on${ids.indexOf(id)}`], widget: tx.referencesById[`widget${ids.indexOf(id)}`] })) } };
  }
export function preparePdfAcroFormRadio(sourceBytes, request) { if (!Buffer.isBuffer(sourceBytes)) invalid(); const source = Buffer.from(sourceBytes); if (source.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Encrypted trailer is not admitted.'); const normalized = normalize(source, request); const admission = admit(source); const built = build(source, normalized, admission); const proof = Object.freeze({ profile: PDF_ACROFORM_RADIO_PROFILE, sourceSha256: normalized.sourceSha256, groupNameSha256: digest(Buffer.from(normalized.groupName)), optionLabelSha256: Object.freeze(normalized.options.map((o) => digest(Buffer.from(o.label)))), options: Object.freeze(normalized.options.map((o, i) => Object.freeze({ page: o.page, rect: o.rect, stateName: stateName(o.label, i), ...built.refs.options[i] }))), parent: built.refs.parent, acroForm: built.refs.acro, sourcePrefixPreserved: true }); return Object.freeze({ bytes: built.bytes, proof }); }
export function inspectPdfAcroFormRadio(sourceBytes, outputBytes, request) { const prepared = preparePdfAcroFormRadio(sourceBytes, request);
if (!outputBytes?.equals(prepared.bytes)) outputInvalid();
const s = parseClassicPdfStructure(outputBytes);
if (s.revisions.length !== 2) outputInvalid();
const admission = admit(sourceBytes);
const catalog = pdfDictionary(resolveClassicPdfObject(s, s.root).value);
if (!same(catalog.get('AcroForm'), prepared.proof.acroForm)) outputInvalid();
const acro = pdfDictionary(resolveClassicPdfObject(s, prepared.proof.acroForm).value);
const parent = pdfDictionary(resolveClassicPdfObject(s, prepared.proof.parent).value);
if (acro.size !== 1 || acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length !== 1 || !same(acro.get('Fields').values[0], prepared.proof.parent) || parent.size !== 5 || parent.get('FT')?.value !== 'Btn' || parent.get('Ff')?.value !== 49152 || parent.get('T')?.type !== 'string' || parent.get('V')?.value !== 'Off' || parent.get('Kids')?.type !== 'array' || parent.get('Kids').values.length !== prepared.proof.options.length) outputInvalid();
if (!parent.get('T').bytes.equals(pdfUtf16BeString(request.groupName).bytes)) outputInvalid();
for (let i = 0;
i < prepared.proof.options.length;
i += 1) { const option = prepared.proof.options[i];
const widget = pdfDictionary(resolveClassicPdfObject(s, option.widget).value);
const page = pdfDictionary(resolveClassicPdfObject(s, admission.pages[option.page - 1].ref).value);
const expectedRect = [option.rect.x, option.rect.y, option.rect.x + option.rect.width, option.rect.y + option.rect.height];
const ap = pdfDictionary(widget.get('AP'));
const normal = pdfDictionary(ap.get('N'));
const off = resolveClassicPdfObject(s, option.off);
const on = resolveClassicPdfObject(s, option.on);
const stream = (o) => o.stream && s.buffer.subarray(o.streamStart, o.streamStart + o.streamLength);
const formOk = (o, expectedOn) => { const v = pdfDictionary(o.value);
return v.size === 5 && v.get('Type')?.value === 'XObject' && v.get('Subtype')?.value === 'Form' && v.get('FormType')?.value === 1 && !v.has('Resources') && v.get('BBox')?.values.map((x) => x.value).join(',') === `0,0,${option.rect.width},${option.rect.height}` && stream(o)?.includes(Buffer.from(expectedOn ? '\nf\n' : '\nS\n', 'latin1'));
};
if (widget.size !== 9 || widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget' || widget.get('FT')?.value !== 'Btn' || widget.get('F')?.value !== 4 || !same(widget.get('Parent'), prepared.proof.parent) || !same(widget.get('P'), admission.pages[option.page - 1].ref) || widget.get('AS')?.value !== 'Off' || widget.get('Rect')?.values.some((x, j) => x.value !== expectedRect[j]) || page.get('Annots')?.type !== 'array' || page.get('Annots').values.filter((entry) => same(entry, option.widget)).length !== 1 || !same(parent.get('Kids').values[i], option.widget) || !same(normal.get('Off'), option.off) || !same(normal.get(option.stateName), option.on) || !formOk(off, false) || !formOk(on, true)) outputInvalid();
} return prepared.proof;
}
export const buildPdfAcroFormRadio = preparePdfAcroFormRadio;
export const verifyPdfAcroFormRadio = inspectPdfAcroFormRadio;
