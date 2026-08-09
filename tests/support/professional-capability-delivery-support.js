import { contextFor, deterministicColorConversionContext } from './professional-capability-context.js';
import { scanAppendContext, scanDuplexContext } from './professional-capability-scan-contexts.js';
import {
  pngFixture,
  psFixture,
  cadFixture,
  printerMarksFixture,
} from './professional-capability-delivery-fixtures.js';

export {
  contextFor,
  deterministicColorConversionContext,
  scanAppendContext,
  scanDuplexContext,
  pngFixture,
  psFixture,
  cadFixture,
  printerMarksFixture,
};
export function readOutcomePath(outcome, path) {
  if (path.endsWith('.length')) {
    const base = path.slice(0, -'.length'.length);
    const value = base.includes('.')
      ? base.split('.').reduce((current, key) => (current == null ? undefined : current[key]), outcome)
      : outcome?.[base];
    return value == null ? undefined : value.length;
  }
  if (!path.includes('.')) return outcome?.[path];
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), outcome);
}

export function assertEffectContract(assert, effectContracts, id, outcome) {
  const contract = effectContracts.contracts?.[id];
  assert.ok(contract, `${id} missing effect contract entry`);
  for (const key of contract.requiredKeys ?? []) {
    const value = readOutcomePath(outcome, key);
    assert.notEqual(value, undefined, `${id} missing required effect key ${key}`);
    assert.notEqual(value, null, `${id} null effect key ${key}`);
  }
  if (contract.method) {
    assert.equal(outcome.method, contract.method, `${id} method mismatch`);
  }
  if (contract.path) {
    assert.equal(outcome.path, contract.path, `${id} path mismatch`);
  }
  if (contract.methodIncludes) {
    assert.match(String(outcome.method ?? ''), new RegExp(contract.methodIncludes, 'i'), `${id} methodIncludes`);
  }
  const forbiddenEquals = new Set(['ok', 'localOnly', 'kind', 'schemaVersion', 'capabilityId', 'familyId']);
  if (contract.equals) {
    for (const [key, expected] of Object.entries(contract.equals)) {
      assert.equal(forbiddenEquals.has(key), false, `${id} contract must not equal.${key} (tautology)`);
      if (key === 'proposedNotApplied' && expected === true) {
        assert.fail(`${id} contract must not pin proposedNotApplied:true (proposal theater)`);
      }
      const actual = readOutcomePath(outcome, key);
      assert.equal(actual, expected, `${id}.${key} equals ${expected}`);
    }
  }
  // Professional delivery must not leave proposal-only theater on applied paths
  if (outcome.proposedNotApplied === true && (outcome.method || '').includes('proposal')) {
    assert.fail(`${id} still returns proposal theater method ${outcome.method}`);
  }
  if (contract.min) {
    for (const [key, minimum] of Object.entries(contract.min)) {
      if (key === 'pdfBytes') {
        assert.ok(Buffer.isBuffer(outcome.pdf) && outcome.pdf.length >= minimum, `${id} pdf bytes`);
        continue;
      }
      const actual = readOutcomePath(outcome, key);
      assert.ok(Number(actual) >= minimum, `${id}.${key} >= ${minimum}`);
    }
  }
  if (contract.requirePdf) {
    assert.ok(Buffer.isBuffer(outcome.pdf) && outcome.pdf.length > 0, `${id} requires pdf artifact`);
  }
  if (contract.requireBytes) {
    assert.ok(Buffer.isBuffer(outcome.bytes) && outcome.bytes.length > 0, `${id} requires bytes artifact`);
  }
  // Independent PDF structure predicates — do not trust handler booleans.
  const pdfBuffer = Buffer.isBuffer(outcome.pdf)
    ? outcome.pdf
    : (Buffer.isBuffer(outcome.bytes) ? outcome.bytes : null);
  const pdfLatin1 = pdfBuffer ? pdfBuffer.toString('latin1') : '';
  if (Array.isArray(contract.pdfMustContain) && contract.pdfMustContain.length > 0) {
    assert.ok(pdfBuffer, `${id} pdfMustContain requires pdf/bytes buffer`);
    for (const marker of contract.pdfMustContain) {
      assert.ok(
        pdfLatin1.includes(String(marker)),
        `${id} pdf missing required marker ${JSON.stringify(marker)}`,
      );
    }
  }
  if (Array.isArray(contract.pdfMustNotContain) && contract.pdfMustNotContain.length > 0) {
    assert.ok(pdfBuffer, `${id} pdfMustNotContain requires pdf/bytes buffer`);
    for (const marker of contract.pdfMustNotContain) {
      assert.equal(
        pdfLatin1.includes(String(marker)),
        false,
        `${id} pdf must not contain ${JSON.stringify(marker)}`,
      );
    }
  }
  if (Array.isArray(contract.pdfMustMatch) && contract.pdfMustMatch.length > 0) {
    assert.ok(pdfBuffer, `${id} pdfMustMatch requires pdf/bytes buffer`);
    for (const pattern of contract.pdfMustMatch) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
      assert.ok(re.test(pdfLatin1), `${id} pdf does not match ${re}`);
    }
  }
  // Mutation claims must prove structure via independent PDF predicates (not handler flags).
  if (contract.claimClass === 'mutation' || contract.mutation === true) {
    const structural =
      (Array.isArray(contract.pdfMustContain) && contract.pdfMustContain.length > 0)
      || (Array.isArray(contract.pdfMustMatch) && contract.pdfMustMatch.length > 0)
      || (Array.isArray(contract.pdfMustNotContain) && contract.pdfMustNotContain.length > 0);
    assert.ok(
      structural,
      `${id} mutation claim lacks pdfMustContain/pdfMustMatch/pdfMustNotContain`,
    );
  }
  const eqKeys = Object.keys(contract.equals ?? {}).filter((k) => !forbiddenEquals.has(k));
  const hasDomain =
    (eqKeys.length > 0)
    || (contract.min && Object.keys(contract.min).length > 0)
    || contract.requirePdf === true
    || contract.requireBytes === true
    || (Array.isArray(contract.pdfMustContain) && contract.pdfMustContain.length > 0)
    || (Array.isArray(contract.pdfMustMatch) && contract.pdfMustMatch.length > 0);
  assert.ok(hasDomain, `${id} effect contract lacks non-tautological domain assert`);
}
