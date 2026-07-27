import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { createAcroFormChoiceEndpoints } from '../src/core/local-host-acroform-choice-endpoints.js';
import { createBatesNumberingEndpoints } from '../src/core/local-host-bates-numbering-endpoints.js';

test('choice and Bates CLI parsers preserve bounded production contracts', () => {
  assert.deepEqual(parseCliArguments(['acroform-choice', 'in.pdf', '--field', 'List', '--page', '1', '--rect', '1,2,100,20', '--options', 'options.json', '--output', 'out.pdf']).optionsPath, 'options.json');
  assert.deepEqual(parseCliArguments(['bates-numbering', 'in.pdf', '--pages', '1,3-5', '--output', 'out.pdf']).pages, [1, 3, 4, 5]);
  assert.throws(() => parseCliArguments(['bates-numbering', 'in.pdf', '--pages', '1-999999999', '--output', 'out.pdf']));
  assert.throws(() => parseCliArguments(['bates-numbering', 'in.pdf', '--pages', '1-2-3', '--output', 'out.pdf']));
});

test('choice and Bates browser clients reject duplicate/hostile request surfaces before POST', () => {
  const json = () => Promise.resolve({});
  const choice = createAcroFormChoiceEndpoints({ json }); const bates = createBatesNumberingEndpoints({ json });
  assert.throws(() => choice.addAcroFormChoice('doc', { profile: 'local-pdf-acroform-choice-v1', sourceSha256: 'a'.repeat(64), page: 1, fieldName: 'List', rect: { x: 1, y: 1, width: 10, height: 10 }, options: [{ label: 'A' }, { label: 'A' }] }));
  assert.throws(() => bates.runBatesNumbering('doc', { profile: 'local-pdf-bates-numbering-v1', sourceSha256: 'a'.repeat(64), pages: [1, 1], start: 0, prefix: '', suffix: '', padding: 3, position: 'bottom-left', margin: 12, fontSize: 10 }));
});

const UUIDS = {
  document: '123e4567-e89b-12d3-a456-426614174000',
  choiceArtifact: '323e4567-e89b-12d3-a456-426614174000',
  batesArtifact: '423e4567-e89b-12d3-a456-426614174000',
  operation: '223e4567-e89b-12d3-a456-426614174000',
};
const SOURCE = 'a'.repeat(64);
const OUTPUT = 'b'.repeat(64);
const COMPLETED = '2026-07-20T12:00:00.000Z';
const CHOICE_VALIDATORS = ['source-sha256', 'private-source-copy', 'bounded-acroform-choice-core', 'independent-choice-reinspection', 'output-sha256'];
const BATES_VALIDATORS = ['source-sha256', 'private-stage', 'workspace-inventory', 'bates-writer', 'independent-reinspection'];

function choiceFixture() {
  const request = { profile: 'local-pdf-acroform-choice-v1', sourceSha256: SOURCE, page: 1, fieldName: 'List', rect: { x: 1, y: 2, width: 10, height: 10 }, options: [{ label: 'A' }, { label: 'B' }] };
  const proof = { profile: request.profile, sourceSha256: SOURCE, page: 1, fieldNameSha256: 'c'.repeat(64), optionLabelSha256: ['d'.repeat(64), 'e'.repeat(64)], rect: request.rect, options: [{ labelSha256: 'd'.repeat(64) }, { labelSha256: 'e'.repeat(64) }], combo: false, font: { object: 1, generation: 0 }, appearance: { object: 2, generation: 0 }, widget: { object: 3, generation: 0 }, acroForm: { object: 4, generation: 0 }, sourcePrefixPreserved: true, appearanceSha256: 'f'.repeat(64) };
  const operation = { schemaVersion: 1, id: UUIDS.operation, type: 'pdf-acroform-choice', inputs: [{ documentId: UUIDS.document, sha256: SOURCE, role: 'source' }], parameters: { profile: request.profile, page: 1, fieldNameSha256: proof.fieldNameSha256, optionLabelSha256: proof.optionLabelSha256, optionCount: 2 }, expected: { outputSha256: OUTPUT, sourcePrefixPreserved: true, unchecked: true }, validation: { passed: true, validators: CHOICE_VALIDATORS, outputSha256: OUTPUT }, completedAt: COMPLETED };
  return { request, result: { artifact: { id: UUIDS.choiceArtifact, documentId: UUIDS.document, displayName: 'choice-form.pdf', mediaType: 'application/pdf', size: 100, sha256: OUTPUT, operation, createdAt: COMPLETED }, proof, limitations: ['One unchecked non-combo choice field only; no selection logic, calculations, actions, XFA, general form editing, or signature preservation.'] } };
}
function batesFixture() {
  const request = { profile: 'local-pdf-bates-numbering-v1', sourceSha256: SOURCE, pages: [1], start: 0, prefix: '', suffix: '', padding: 3, position: 'bottom-left', margin: 12, fontSize: 10 };
  const operation = { schemaVersion: 1, id: UUIDS.operation, type: 'pdf-bates-numbering', inputs: [{ documentId: UUIDS.document, sha256: SOURCE, role: 'source' }], parameters: { profile: request.profile, pages: [1], position: request.position, padding: request.padding }, expected: { outputSha256: OUTPUT, sourcePrefixPreserved: true }, validation: { passed: true, validators: BATES_VALIDATORS, outputSha256: OUTPUT }, completedAt: COMPLETED };
  return { request, result: { artifact: { id: UUIDS.batesArtifact, documentId: UUIDS.document, displayName: 'bates-numbered.pdf', mediaType: 'application/pdf', size: 100, sha256: OUTPUT, operation, createdAt: COMPLETED }, proof: { profile: request.profile, sourceSha256: SOURCE, outputSha256: OUTPUT, pageCount: 1, pages: [{ page: 1, text: '000' }], sourcePrefixPreserved: true, revisionCount: 2, resourceName: 'BatesHelv' }, limitations: ['Only passive Bates text numbering is added; source forms, actions, tags, layers, signatures, and unsupported structures are rejected.'] } };
}
test('choice and Bates browser clients accept and freeze production provenance, then reject tampering', async () => {
  const choice = choiceFixture(); const choiceClient = createAcroFormChoiceEndpoints({ json: async () => ({ result: choice.result }) }); const acceptedChoice = await choiceClient.addAcroFormChoice(UUIDS.document, choice.request); assert.ok(Object.isFrozen(acceptedChoice));
  const choiceTampered = structuredClone(choice.result); choiceTampered.proof.options[0].labelSha256 = '0'.repeat(64); await assert.rejects(createAcroFormChoiceEndpoints({ json: async () => ({ result: choiceTampered }) }).addAcroFormChoice(UUIDS.document, choice.request));
  for (const mutate of [(value) => { value.artifact.sha256 = '0'.repeat(64); }, (value) => { value.artifact.createdAt = 'bad'; }, (value) => { value.artifact.operation.inputs[0].role = 'other'; }, (value) => { value.artifact.operation.validation.validators = ['wrong']; }]) { const tampered = structuredClone(choice.result); mutate(tampered); await assert.rejects(createAcroFormChoiceEndpoints({ json: async () => ({ result: tampered }) }).addAcroFormChoice(UUIDS.document, choice.request)); }
  const bates = batesFixture(); const batesClient = createBatesNumberingEndpoints({ json: async () => ({ result: bates.result }) }); const acceptedBates = await batesClient.runBatesNumbering(UUIDS.document, bates.request); assert.ok(Object.isFrozen(acceptedBates));
  const batesTampered = structuredClone(bates.result); batesTampered.proof.pages[0].text = '999'; await assert.rejects(createBatesNumberingEndpoints({ json: async () => ({ result: batesTampered }) }).runBatesNumbering(UUIDS.document, bates.request));
  const batesPageTampered = structuredClone(bates.result); batesPageTampered.proof.pageCount = 0; await assert.rejects(createBatesNumberingEndpoints({ json: async () => ({ result: batesPageTampered }) }).runBatesNumbering(UUIDS.document, bates.request));
});
