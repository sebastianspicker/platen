import { createHash } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../../scripts/host/pdf-factory.mjs';
import { encodeRgbaPng } from '../../scripts/host/raster-png-codec.mjs';
import {
  redactionFixture,
  signatureFixture,
  formFixture,
  editableTextPdf,
} from '../../scripts/host/professional-capability/fixtures.mjs';

export const pngFixture = encodeRgbaPng({
  width: 4,
  height: 4,
  pixels: Buffer.alloc(4 * 4 * 4, 200),
});
export const psFixture = Buffer.from('%!PS-Adobe-3.0\n(Hello) show\nshowpage\n', 'latin1');
export const cadFixture = Buffer.from(JSON.stringify({
  title: 'CAD',
  entities: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 50 }],
}), 'utf8');

export function contextFor(id) {
  const blank = createBlankPdf({ pages: 1, title: 'evidence' });
  const text = 'Evidence alpha beta. Contract value is $12,000. Email j.doe@example.com on 2026-07-01. Chapter One';
  const ctx = {
    deterministic: true,
    seed: id,
    pages: 1,
    title: 'evidence',
    text,
    question: 'What is the contract value?',
    sourcePdf: blank,
    sourceBytes: blank,
    inputBytes: blank,
    leftText: 'alpha beta gamma',
    rightText: 'alpha delta gamma',
    html: '<p>Hello evidence</p>',
    clipboardText: 'clipboard evidence',
    jobName: 'job-evidence',
    postscript: psFixture.toString('latin1'),
    parts: ['A', 'B'],
    entities: [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }],
    rows: [['k', 'v'], ['1', '2']],
    slides: ['S1', 'S2'],
    regionText: 'region',
    documents: [
      { id: 'a', text: 'Safety valve review finds risk.' },
      { id: 'b', text: 'Safety valve maintenance overdue.' },
    ],
    files: [
      { name: 'a.txt', bytes: Buffer.from('one'), description: 'A' },
      { name: 'b.txt', bytes: Buffer.from('two'), description: 'B' },
    ],
    query: 'a.txt',
    prompt: 'blueprint stamp',
    claims: ['Contract'],
    target: 'es',
    targetLanguage: 'es',
    instruction: 'highlight risk',
    body: 'office body',
    consent: true,
    pngBytes: pngFixture,
    region: { x: 0, y: 0, width: 1, height: 1 },
    sources: [
      { kind: 'text', bytes: Buffer.from('Part A', 'utf8'), extension: '.txt', label: 'A' },
      { kind: 'text', bytes: Buffer.from('Part B', 'utf8'), extension: '.txt', label: 'B' },
    ],
    secret: 'secret',
    value: 'Ada Lovelace',
    userPassword: 'UserPass12!abc',
    ownerPassword: 'OwnerPass12!xyz',
    find: 'hello world',
    replace: 'HELLO WORLD',
  };
  if (id === 'convert.images-to-pdf' || id === 'export.selected-region' || id === 'export.images') {
    ctx.sourceBytes = pngFixture;
    ctx.pngBytes = pngFixture;
  }
  if (id === 'create.postscript-to-pdf') {
    ctx.sourceBytes = psFixture;
    ctx.inputBytes = psFixture;
  }
  if (id === 'create.cad-to-pdf') {
    ctx.sourceBytes = cadFixture;
    ctx.inputBytes = cadFixture;
  }
  if (id === 'create.multiformat-combine') {
    ctx.sources = [
      { kind: 'text', bytes: Buffer.from('Alpha', 'utf8'), extension: '.txt' },
      { kind: 'text', bytes: Buffer.from('Beta', 'utf8'), extension: '.txt' },
    ];
  }
  if (id.startsWith('sign.')) {
    ctx.sourcePdf = signatureFixture();
    ctx.sourceBytes = ctx.sourcePdf;
  }
  if (id === 'sign.identity-verification') {
    // Bound expected fingerprint — never self-match theater (expected defaults to claim hash).
    ctx.claimedSubject = 'CN=Local Signer';
    ctx.expectedFingerprint = createHash('sha256').update('CN=Local Signer').digest('hex');
  }
  if (id.startsWith('redaction.') || id === 'sanitize.selective-content') {
    ctx.sourcePdf = redactionFixture({ secret: 'secret' });
    ctx.sourceBytes = ctx.sourcePdf;
    ctx.secret = 'secret';
  }
  if (id.startsWith('forms.')) {
    ctx.sourcePdf = formFixture();
    ctx.sourceBytes = ctx.sourcePdf;
  }
  if (id === 'edit.text' || id === 'edit.find-replace' || id === 'edit.text-reflow') {
    ctx.sourcePdf = editableTextPdf('hello world');
    ctx.sourceBytes = ctx.sourcePdf;
  }
  if (id.startsWith('portfolios.') || id === 'document.embedded-files') {
    delete ctx.sourcePdf;
  }
  if (id === 'security.encryption-aes' || id === 'security.open-password' || id === 'security.security-envelopes' || id === 'security.certificate-encryption') {
    ctx.sourcePdf = createTextPdf({ text: 'CONFIDENTIAL-PAYLOAD', title: 'Sensitive' });
    ctx.secret = 'CONFIDENTIAL-PAYLOAD';
  }
  if (id === 'viewer.search' || id === 'viewer.advanced-search') {
    ctx.query = 'Contract';
    ctx.text = 'Evidence alpha beta. Contract value is $12,000. Email j.doe@example.com on 2026-07-01. Chapter One';
  }
  if (id === 'accessibility.alt-text') {
    ctx.altText = 'Chart of quarterly revenue';
    delete ctx.text; // avoid long bulk text as alt
  }
    if (id.startsWith('aec.')) {
    delete ctx.sourcePdf;
    delete ctx.sourceBytes;
  }
  return ctx;
}


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
