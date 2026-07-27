import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runAcroFormCheckboxCommand, runAcroFormRadioCommand, runAcroFormTextFieldCommand } from '../scripts/cli/commands/acroform.mjs';
import { runAcroFormChoiceCommand } from '../scripts/cli/commands/acroform-choice.mjs';
test('AcroForm CLI parsers retain bounded canonical options', () => {
  assert.deepEqual(parseCliArguments(['add-checkbox', 'input.pdf', '--field-name', 'agree', '--page', '2', '--rect', '1,2,10,12', '--output', 'out.pdf']), { command: 'add-checkbox', input: 'input.pdf', fieldName: 'agree', page: 2, rect: { x: 1, y: 2, width: 10, height: 12 }, output: 'out.pdf' });
  assert.deepEqual(parseCliArguments(['add-radio-group', 'input.pdf', '--group-name', 'choice', '--options', 'options.json', '--output', 'out.pdf']), { command: 'add-radio-group', input: 'input.pdf', groupName: 'choice', optionsPath: 'options.json', output: 'out.pdf' });
  assert.deepEqual(parseCliArguments(['acroform-text-field', 'input.pdf', '--page', '2', '--field', 'name', '--rect', '1,2,100,20', '--output', 'out.pdf']), { command: 'acroform-text-field', input: 'input.pdf', fieldName: 'name', page: 2, rect: { x: 1, y: 2, width: 100, height: 20 }, output: 'out.pdf' });
  assert.throws(() => parseCliArguments(['add-checkbox', 'input.pdf', '--field-name', 'agree', '--page', '1', '--rect', '1,2,0,2', '--output', 'out.pdf']), { code: 'CLI_INVALID_OPTION' });
});
test('AcroForm direct commands bind source digest, signal, and exclusive output', async () => {
  const calls = []; const copied = []; const emitted = [];
  const application = { acroFormCheckbox: { add: async (...args) => { calls.push(['checkbox', ...args]); return { artifact: { id: 'a' } }; } }, acroFormRadio: { add: async (...args) => { calls.push(['radio', ...args]); return { artifact: { id: 'b' } }; } }, acroFormTextField: { add: async (...args) => { calls.push(['text-field', ...args]); return { artifact: { id: 'c' } }; } }, store: { getArtifact: (id) => ({ filePath: `${id}.pdf` }) } };
  const runtime = { cancelled: () => {}, copyExclusive: async (...args) => copied.push(args), emit: async (_stdout, value) => emitted.push(value), readLocalInputBytes: async () => ({ bytes: Buffer.from('[{"label":"A","page":1,"rect":{"x":1,"y":1,"width":4,"height":4}},{"label":"B","page":1,"rect":{"x":8,"y":1,"width":4,"height":4}}]') }) };
  const signal = new AbortController().signal; const document = { id: 'doc', sha256: 'c'.repeat(64) };
  await runAcroFormCheckboxCommand(application, { command: 'add-checkbox', page: 1, fieldName: 'agree', rect: { x: 1, y: 1, width: 4, height: 4 }, output: 'checkbox.pdf' }, document, process.stdout, signal, runtime);
  await runAcroFormRadioCommand(application, { command: 'add-radio-group', groupName: 'choice', optionsPath: 'options.json', output: 'radio.pdf' }, document, process.stdout, signal, runtime);
  await runAcroFormTextFieldCommand(application, { command: 'acroform-text-field', fieldName: 'name', page: 1, rect: { x: 1, y: 1, width: 10, height: 10 }, output: 'text.pdf' }, document, process.stdout, signal, runtime);
  assert.equal(calls[0][2].sourceSha256, document.sha256); assert.equal(calls[0][3].signal, signal); assert.equal(calls[1][2].options.length, 2); assert.equal(calls[2][2].fieldName, 'name'); assert.equal(copied.length, 3); assert.equal(emitted.length, 3);
});

test('AcroForm choice CLI imports and executes with exact option records', async () => {
  const calls = [];
  const application = {
    acroFormChoice: {
      add: async (...args) => {
        calls.push(args);
        return { artifact: { id: 'choice' } };
      },
    },
    store: { getArtifact: () => ({ filePath: 'choice.pdf' }) },
  };
  const runtime = {
    readLocalInputBytes: async () => ({ bytes: Buffer.from('[{"label":"A"},{"label":"B"}]') }),
    cancelled: () => {},
    copyExclusive: async () => {},
    emit: async () => {},
  };
  const document = { id: 'doc', sha256: 'c'.repeat(64) };
  await runAcroFormChoiceCommand(application, {
    optionsPath: 'options.json',
    page: 1,
    fieldName: 'List',
    rect: { x: 1, y: 2, width: 10, height: 10 },
    output: 'choice.pdf',
  }, document, null, new AbortController().signal, runtime);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], {
    profile: 'local-pdf-acroform-choice-v1',
    sourceSha256: document.sha256,
    page: 1,
    fieldName: 'List',
    rect: { x: 1, y: 2, width: 10, height: 10 },
    options: [{ label: 'A' }, { label: 'B' }],
  });
});

test('AcroForm CLI stops before copy and emit when cancellation arrives after service resolution', async () => {
  let copied = 0; let emitted = 0; const application = { acroFormCheckbox: { add: async () => ({ artifact: { id: 'a' } }) }, store: { getArtifact: () => ({ filePath: 'a.pdf' }) } };
  const runtime = { cancelled: () => { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; }, copyExclusive: async () => { copied += 1; }, emit: async () => { emitted += 1; } };
  await assert.rejects(runAcroFormCheckboxCommand(application, { command: 'add-checkbox', page: 1, fieldName: 'agree', rect: { x: 1, y: 1, width: 4, height: 4 }, output: 'checkbox.pdf' }, { id: 'doc', sha256: 'c'.repeat(64) }, null, new AbortController().signal, runtime), { code: 'JOB_CANCELLED' });
  assert.equal(copied, 0); assert.equal(emitted, 0);
});

test('AcroForm radio CLI zeroes options bytes after parse failure and cancellation', async () => {
  const invalidBytes = Buffer.from('{not-json}'); const invalidApplication = { acroFormRadio: { add: async () => { throw new Error('must not call'); } } };
  await assert.rejects(runAcroFormRadioCommand(invalidApplication, { command: 'add-radio-group', groupName: 'choice', optionsPath: 'options.json', output: 'radio.pdf' }, { id: 'doc', sha256: 'c'.repeat(64) }, null, undefined, { readLocalInputBytes: async () => ({ bytes: invalidBytes }), fail() {} }), { code: 'CLI_INVALID_OPTION' });
  assert(invalidBytes.every((byte) => byte === 0));
  const validBytes = Buffer.from('[{"label":"A","page":1,"rect":{"x":1,"y":1,"width":4,"height":4}},{"label":"B","page":1,"rect":{"x":8,"y":1,"width":4,"height":4}}]'); const application = { acroFormRadio: { add: async () => ({ artifact: { id: 'b' } }) }, store: { getArtifact: () => ({ filePath: 'b.pdf' }) } };
  await assert.rejects(runAcroFormRadioCommand(application, { command: 'add-radio-group', groupName: 'choice', optionsPath: 'options.json', output: 'radio.pdf' }, { id: 'doc', sha256: 'c'.repeat(64) }, null, undefined, { readLocalInputBytes: async () => ({ bytes: validBytes }), cancelled: () => { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; }, copyExclusive: async () => { throw new Error('must not copy'); }, emit: async () => { throw new Error('must not emit'); } }), { code: 'JOB_CANCELLED' });
  assert(validBytes.every((byte) => byte === 0));
});
