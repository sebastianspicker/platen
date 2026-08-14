import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPdfJavaScriptRemovalLocus } from '../scripts/host/pdf-javascript-removal-contract.mjs';

const INVALID_MESSAGE = 'The PDF JavaScript removal request is outside the supported bounded profile.';
const reference = (object, generation = 0) => ({ type: 'ref', object, generation });
const name = (value) => ({ type: 'name', value });
const string = (value) => ({ type: 'string', bytes: Buffer.from(value, 'latin1') });
const dictionary = (entries) => ({ type: 'dict', entries: new Map(entries) });
const array = (values) => ({ type: 'array', values });
const catalog = (entries) => dictionary([
  ['Type', name('Catalog')], ['Pages', reference(2)], ...entries,
]);
const action = (script = 'app.alert(1)') => ({
  value: dictionary([['S', name('JavaScript')], ['JS', string(script)]]),
});
const nameTree = (entryName = 'startup', actionRef = reference(4)) => ({
  value: dictionary([['Names', array([string(entryName), actionRef])]]),
});

function assertInvalid(operation) {
  assert.throws(operation, (error) => error instanceof Error
    && error.message === INVALID_MESSAGE
    && error.code === 'INVALID_PDF_JAVASCRIPT_REMOVAL');
}

test('classifies and freezes the sole supported Catalog OpenAction locus', () => {
  const actionReference = reference(3, 2); const resolved = [];
  const result = classifyPdfJavaScriptRemovalLocus(
    catalog([['OpenAction', actionReference]]),
    (value) => { resolved.push(value); return action(); },
  );
  assert.deepEqual(result, {
    kind: 'open-action', actionReference,
    deletionReferences: [actionReference],
  });
  assert.deepEqual(resolved, [actionReference]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.actionReference), true);
  assert.equal(Object.isFrozen(result.deletionReferences), true);
  assert.throws(() => result.deletionReferences.push(reference(9)), TypeError);
});

test('classifies and freezes the sole supported Catalog Names JavaScript locus', () => {
  const namesReference = reference(3); const actionReference = reference(4); const resolved = [];
  const result = classifyPdfJavaScriptRemovalLocus(
    catalog([['Names', dictionary([['JavaScript', namesReference]])]]),
    (value) => {
      resolved.push(value);
      return value.object === 3 ? nameTree('startup', actionReference) : action('boot()');
    },
  );
  assert.deepEqual(result, {
    kind: 'names', namesReference, actionReference,
    deletionReferences: [namesReference, actionReference],
  });
  assert.deepEqual(resolved, [namesReference, actionReference]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.namesReference), true);
  assert.equal(Object.isFrozen(result.actionReference), true);
  assert.equal(Object.isFrozen(result.deletionReferences), true);
});

test('rejects missing, ambiguous, unsupported, and malformed locus shapes before resolution', () => {
  const neverResolve = () => assert.fail('invalid loci must not resolve references');
  for (const value of [
    undefined,
    dictionary([['Type', name('Pages')], ['Pages', reference(2)], ['OpenAction', reference(3)]]),
    dictionary([['Type', name('Catalog')], ['OpenAction', reference(3)]]),
    catalog([]),
    catalog([['OpenAction', reference(3)], ['Names', dictionary([['JavaScript', reference(4)]])]]),
    catalog([['OpenAction', reference(3)], ['AA', dictionary([])]]),
    catalog([['OpenAction', dictionary([])]]),
    catalog([['Names', dictionary([['JavaScript', dictionary([])]])]]),
  ]) assertInvalid(() => classifyPdfJavaScriptRemovalLocus(value, neverResolve));
});

test('rejects invalid resolved actions, name trees, pairs, and shared references', () => {
  const openCatalog = catalog([['OpenAction', reference(3)]]);
  assertInvalid(() => classifyPdfJavaScriptRemovalLocus(openCatalog, () => ({ stream: true, value: action().value })));
  assertInvalid(() => classifyPdfJavaScriptRemovalLocus(openCatalog, () => ({ value: dictionary([['S', name('JavaScript')], ['JS', string('')]]) })));
  const namesCatalog = catalog([['Names', dictionary([['JavaScript', reference(3)]])]]);
  assertInvalid(() => classifyPdfJavaScriptRemovalLocus(namesCatalog, () => ({ compressed: true, value: nameTree().value })));
  assertInvalid(() => classifyPdfJavaScriptRemovalLocus(namesCatalog, () => nameTree('', reference(4))));
  let resolves = 0;
  assertInvalid(() => classifyPdfJavaScriptRemovalLocus(namesCatalog, () => {
    resolves += 1;
    return resolves === 1 ? nameTree('startup', reference(3)) : action();
  }));
  assert.equal(resolves, 2);
});
