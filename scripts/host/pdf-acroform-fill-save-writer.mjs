import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { acroFormDigest, boundedNfcText, inspectClassicAcroForm, requireExactPlain } from './pdf-acroform-validation-core.mjs';

export const PDF_ACROFORM_FILL_SAVE_PROFILE = 'local-acroform-fill-save-v1';
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message) { throw failure('INVALID_PDF_ACROFORM_FILL_SAVE', message); }
function unsupported(message) { throw failure('UNSUPPORTED_PDF_ACROFORM_FILL_SAVE_SOURCE', message); }
function outputInvalid(message) { throw failure('INVALID_PDF_ACROFORM_FILL_SAVE_OUTPUT', message); }
function same(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function stateNames(field) { const normal = field.entries.get('AP')?.type === 'dict' ? pdfDictionary(field.entries.get('AP')).get('N') : null; return normal?.type === 'dict' ? [...normal.entries.keys()] : null; }
function normalize(source, request) {
  try { requireExactPlain(request, ['profile', 'sourceSha256', 'fieldName', 'value']); } catch (error) { invalid(error.message); }
  if (request.profile !== PDF_ACROFORM_FILL_SAVE_PROFILE || !/^[0-9a-f]{64}$/u.test(request.sourceSha256) || acroFormDigest(source) !== request.sourceSha256) invalid('The profile or source digest is invalid.');
  const fieldName = boundedNfcText(request.fieldName, 'fieldName');
  if (typeof request.value !== 'string' && typeof request.value !== 'boolean') invalid('value must be a string or boolean.');
  if (typeof request.value === 'string') boundedNfcText(request.value, 'value', { minimum: 0, maximum: 2000 });
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, fieldName, value: request.value });
}
function admitted(source) { try { return inspectClassicAcroForm(source); } catch (error) { unsupported(error.message); } }
function selectField(admission, request) {
  const candidates = admission.fields.filter((field) => field.name === request.fieldName);
  if (!candidates.length) unsupported('The requested field was not inspected.');
  if (candidates.length === 1) return candidates[0];
  const matches = candidates.filter((field) => field.type === 'Btn' && (field.flags & 32768) && typeof request.value === 'string' && stateNames(field)?.includes(request.value));
  if (!matches.length && candidates.every((field) => field.type === 'Btn' && (field.flags & 32768))) invalid('Radio value is not an inspected on-state.'); if (matches.length !== 1) unsupported('The requested field is ambiguous.');
  return matches[0];
}
function build(source, normalized, admission) {
  const target = selectField(admission, normalized); const entries = new Map(target.entries); let normalizedValue;
  if (target.type === 'Tx') { if (typeof normalized.value !== 'string') invalid('Text value must be a string.'); normalizedValue = normalized.value; entries.set('V', pdfUtf16BeString(normalizedValue)); }
  else if (target.type === 'Ch') {
    if (typeof normalized.value !== 'string') invalid('Choice value must be a string.'); const options = target.entries.get('Opt');
    if (options?.type !== 'array' || options.values.some((option) => option?.type !== 'string')) unsupported('Choice options are not canonical.'); if (!options.values.some((option) => option.bytes.equals(pdfUtf16BeString(normalized.value).bytes))) invalid('Choice value is not an inspected option.');
    normalizedValue = normalized.value; entries.set('V', pdfUtf16BeString(normalizedValue));
  } else if (target.flags & 32768) {
    if (typeof normalized.value !== 'string' || !stateNames(target)?.includes(normalized.value) || normalized.value === 'Off' || !target.parentRef) invalid('Radio value must be an inspected on-state.');
    normalizedValue = normalized.value; entries.set('AS', Object.freeze({ type: 'name', value: normalizedValue }));
  } else {
    if (typeof normalized.value !== 'boolean') invalid('Checkbox value must be boolean.'); const names = stateNames(target);
    if (!names || names.length !== 2 || !names.includes('Off')) unsupported('Checkbox appearances are not canonical.');
    const on = names.find((name) => name !== 'Off'); normalizedValue = normalized.value; entries.set('V', Object.freeze({ type: 'name', value: normalizedValue ? on : 'Off' })); entries.set('AS', Object.freeze({ type: 'name', value: normalizedValue ? on : 'Off' }));
  }
  const updates = [{ reference: target.reference, value: Object.freeze({ type: 'dict', entries }) }];
  if (target.type === 'Btn' && (target.flags & 32768)) { const parent = new Map(target.parent.entries); parent.set('V', Object.freeze({ type: 'name', value: normalizedValue })); updates.push({ reference: target.parentRef, value: Object.freeze({ type: 'dict', entries: parent }) }); }
  let transaction; try { transaction = planPdfObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates, additions: [], info: { kind: 'preserve' }, changingId: null }); } catch { unsupported('The derived revision could not be planned.'); }
  const bytes = Buffer.concat([source, transaction.revision.bytes]);
  const fieldType = target.type === 'Tx' ? 'text' : target.type === 'Ch' ? 'choice' : (target.flags & 32768) ? 'radio' : 'checkbox';
  return Object.freeze({ bytes, target, normalizedValue, proof: Object.freeze({ profile: normalized.profile, sourceSha256: normalized.sourceSha256, fieldNameSha256: acroFormDigest(Buffer.from(normalized.fieldName, 'utf8')), valueSha256: acroFormDigest(Buffer.from(String(normalizedValue), 'utf8')), fieldType, widgetReference: Object.freeze({ object: target.reference.object, generation: target.reference.generation }), sourcePrefixPreserved: true, semanticValueValidated: true, revisionCount: admission.structure.revisions.length + 1 }) });
}
function verify(source, output, normalized, built) {
  if (!Buffer.isBuffer(output) || !output.subarray(0, source.length).equals(source)) outputInvalid('The source prefix changed.');
  let reopened; try { reopened = parsePdfStructure(output); } catch { outputInvalid('The output cannot be reopened.'); }
  let sourceRevisions; try { sourceRevisions = parsePdfStructure(source).revisions.length; } catch { outputInvalid('The source cannot be reopened.'); }
  if (reopened.revisions.length !== sourceRevisions + 1) outputInvalid('The output revision count is invalid.');
  let widget; try { widget = pdfDictionary(resolvePdfObject(reopened, built.target.reference).value); } catch { outputInvalid('The target widget is absent.'); }
  const expected = built.normalizedValue;
  if (built.proof.fieldType === 'text' || built.proof.fieldType === 'choice') {
    const actual = widget.get('V'); const bytes = actual?.type === 'string' ? actual.bytes : null; if (!bytes?.equals(pdfUtf16BeString(expected).bytes)) outputInvalid('The reopened field value is invalid.');
  } else if (built.proof.fieldType === 'radio') {
    const parent = pdfDictionary(resolvePdfObject(reopened, built.target.parentRef).value); if (parent.get('V')?.value !== expected || widget.get('AS')?.value !== expected) outputInvalid('The reopened radio state is invalid.');
  } else {
    const state = expected ? stateNames(built.target).find((name) => name !== 'Off') : 'Off'; if (widget.get('V')?.value !== state || widget.get('AS')?.value !== state) outputInvalid('The reopened checkbox state is invalid.');
  }
  return built.proof;
}
export function preparePdfAcroFormFillSave(sourceBytes, request) { if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.'); const source = Buffer.from(sourceBytes); return build(source, normalize(source, request), admitted(source)); }
export function inspectPdfAcroFormFillSave(sourceBytes, outputBytes, request) { const source = Buffer.from(sourceBytes); const normalized = normalize(source, request); const built = build(source, normalized, admitted(source)); if (!outputBytes.equals(built.bytes)) outputInvalid('The derived bytes differ from the bounded transaction.'); return verify(source, outputBytes, normalized, built); }
