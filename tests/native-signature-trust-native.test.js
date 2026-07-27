import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, 'native/pdfkit-helper');
const sourceRoot = join(packageRoot, 'Sources/PDFSignatureTrust');
const executable = join(packageRoot, '.build/debug/pdf-signature-trust');
const limits = Object.freeze({
  maxPdfBytes: 134217728, maxSignatures: 100,
  maxCmsBytesPerSignature: 1048576, maxCmsBytesTotal: 8388608,
  maxCertificatesPerSignature: 16, maxCertificateBytes: 65536,
  maxBerDepth: 32, maxBerNodes: 32768,
});
const unsignedPdf = Buffer.from('%PDF-1.7\nunsigned native trust fixture\n');

function digest(data) { return createHash('sha256').update(data).digest('hex'); }
function source(name) { return readFile(join(sourceRoot, name), 'utf8'); }
function request(pdf, records = [], overrides = {}) {
  return JSON.stringify({
    version: 1, operation: 'validateEmbeddedCertificateChains', inputFilename: 'input.pdf',
    sourceSha256: digest(pdf), limits, records, ...overrides,
  });
}
function record(index, cms, { byteRange = [0, 1, 2, 1], subFilter = 'adbe.pkcs7.detached' } = {}) {
  return { byteRange, subFilter, cmsFilename: `dumps/input.pdf.sig${index}`, cmsSha256: digest(cms) };
}
async function workspace(t, pdf = unsignedPdf) {
  const path = await mkdtemp('/private/tmp/pdf-signature-trust-native-');
  t.after(() => rm(path, { recursive: true, force: true }));
  await chmod(path, 0o700);
  await writeFile(join(path, 'input.pdf'), pdf, { mode: 0o600 });
  return path;
}
async function stageRequest(path, pdf, records) {
  await writeFile(join(path, 'request.json'), request(pdf, records), { mode: 0o600 });
}
function run(path) {
  const result = spawnSync(executable, ['--request', join(path, 'request.json')], { cwd: path, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { text: result.stdout, response: JSON.parse(result.stdout) };
}
function berLength(length) {
  if (length < 128) return Buffer.from([length]);
  const octets = [];
  for (let value = length; value > 0; value >>>= 8) octets.unshift(value & 0xff);
  return Buffer.from([0x80 | octets.length, ...octets]);
}
function tlv(tag, contents) { return Buffer.concat([Buffer.from([tag]), berLength(contents.length), contents]); }

test('native signature trust v2 target is isolated from PDF parsing and forbidden trust APIs', async () => {
  const build = spawnSync('swift', ['build', '--product', 'pdf-signature-trust'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const packageFile = await readFile(join(packageRoot, 'Package.swift'), 'utf8');
  assert.match(packageFile, /pdf-signature-trust/u);
  assert.doesNotMatch(packageFile.match(/name: "PDFSignatureTrust"[\s\S]*?\n\s*\),/u)?.[0] ?? '', /CoreGraphics|PDFKit|AppKit/u);
  const files = ['Models.swift', 'RequestValidation.swift', 'WorkspaceIO.swift', 'BERFraming.swift', 'CertificateTrust.swift', 'main.swift'];
  for (const file of files) {
    const value = await source(file);
    assert.ok(value.split(/\r?\n/u).length <= 260, `${file} must remain bounded`);
    assert.doesNotMatch(value, /\b(?:CoreGraphics|PDFKit|AppKit|Timestamp|Revocation|SecIdentity|SecKeychain|SecItem|SecTrustSetAnchorCertificates|SecTrustSetExceptions)\b/u);
  }
  await assert.rejects(source('PDFSignatureExtraction.swift'), { code: 'ENOENT' });
  assert.match(await source('WorkspaceIO.swift'), /openat\(/u);
  assert.match(await source('CertificateTrust.swift'), /CMSDecoderSetDetachedContent/u);
  assert.match(await source('CertificateTrust.swift'), /CMSDecoderCopySignerStatus/u);
  assert.match(await source('CertificateTrust.swift'), /SecTrustGetNetworkFetchAllowed/u);
  const trust = await source('CertificateTrust.swift');
  assert.ok(trust.indexOf('certificates.count <= limits.maxCertificatesPerSignature') < trust.indexOf('embedded.insert(data)'));
});

test('native signature trust accepts only the exact v2 request and does not write source bytes', async (t) => {
  const path = await workspace(t);
  await stageRequest(path, unsignedPdf, []);
  const before = await readFile(join(path, 'input.pdf'));
  const { response } = run(path);
  assert.equal(response.ok, true);
  assert.equal(response.result.schema, 'macos-signature-chain-receipt-v2');
  assert.equal(response.result.profile, 'macos-basic-x509-current-trust-v2');
  assert.deepEqual(response.result.records, []);
  assert.equal(response.result.sourceSha256, digest(unsignedPdf));
  assert.deepEqual(await readFile(join(path, 'input.pdf')), before);
  assert.equal((await stat(join(path, 'input.pdf'))).size, unsignedPdf.length);

  await writeFile(join(path, 'request.json'), request(unsignedPdf, [], { unknown: true }), { mode: 0o600 });
  assert.equal(run(path).response.error.code, 'INVALID_REQUEST');
  await writeFile(join(path, 'request.json'), request(unsignedPdf, [], { limits: { ...limits, maxBerDepth: 31 } }), { mode: 0o600 });
  assert.equal(run(path).response.error.code, 'INVALID_REQUEST');
  await writeFile(join(path, 'request.json'), request(unsignedPdf, [], { sourceSha256: '0'.repeat(64) }), { mode: 0o600 });
  assert.equal(run(path).response.error.code, 'SOURCE_MISMATCH');

  const cms = Buffer.from([0x30, 0x00]);
  await mkdir(join(path, 'dumps'), { mode: 0o700 });
  await writeFile(join(path, 'dumps/input.pdf.sig0'), cms, { mode: 0o600 });
  const badRecord = { ...record(0, cms), cmsFilename: 'dumps/input.pdf.sig1' };
  await stageRequest(path, unsignedPdf, [badRecord]);
  assert.equal(run(path).response.error.code, 'INVALID_REQUEST');
});

test('native signature trust binds private CMS dumps, hashes, and byte limits', async (t) => {
  const pdf = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const path = await workspace(t, pdf);
  const dumps = join(path, 'dumps');
  await mkdir(dumps, { mode: 0o700 });
  const cms = Buffer.from([0x30, 0x00]);
  const dump = join(dumps, 'input.pdf.sig0');
  await writeFile(dump, cms, { mode: 0o600 });
  await stageRequest(path, pdf, [record(0, cms)]);
  let result = run(path);
  assert.equal(result.response.result.records[0].cmsSha256, digest(cms));
  assert.equal(result.response.result.records[0].certificateChain.reason, 'malformed-cms');
  assert.doesNotMatch(result.text, /input\.pdf\.sig0|\/private\/tmp/u);

  await stageRequest(path, pdf, [record(0, cms, { subFilter: null })]);
  result = run(path);
  assert.equal(result.response.result.records[0].subFilter, null);
  assert.equal(result.response.result.records[0].certificateChain.reason, 'unsupported-subfilter');

  await chmod(dump, 0o644);
  assert.equal(run(path).response.error.code, 'UNSAFE_WORKSPACE');
  await chmod(dump, 0o600);
  await stageRequest(path, pdf, [{ ...record(0, cms), cmsSha256: '0'.repeat(64) }]);
  assert.equal(run(path).response.error.code, 'SOURCE_MISMATCH');

  await rm(dump);
  const target = join(path, 'dump-target');
  await writeFile(target, cms, { mode: 0o600 });
  await symlink(target, dump);
  await stageRequest(path, pdf, [record(0, cms)]);
  assert.equal(run(path).response.error.code, 'UNSAFE_WORKSPACE');
  await rm(dump);
  await link(target, dump);
  assert.equal(run(path).response.error.code, 'UNSAFE_WORKSPACE');
  await rm(dump);

  const oversized = Buffer.alloc(limits.maxCmsBytesPerSignature + 1);
  await writeFile(dump, oversized, { mode: 0o600 });
  await stageRequest(path, pdf, [record(0, oversized)]);
  assert.equal(run(path).response.error.code, 'RESOURCE_LIMIT');
  await rm(dump);

  const oneMiB = Buffer.alloc(limits.maxCmsBytesPerSignature);
  const records = [];
  for (let index = 0; index < 9; index += 1) {
    await writeFile(join(dumps, `input.pdf.sig${index}`), oneMiB, { mode: 0o600 });
    records.push(record(index, oneMiB, { byteRange: [0, 1, 2 + index, 1] }));
  }
  await stageRequest(path, pdf, records);
  assert.equal(run(path).response.error.code, 'RESOURCE_LIMIT');
});

test('bounded BER framing accepts indefinite CMS envelopes and rejects malformed or excessive trees', async (t) => {
  const pdf = Buffer.from('0123456789');
  const path = await workspace(t, pdf);
  const dumps = join(path, 'dumps');
  await mkdir(dumps, { mode: 0o700 });
  const integer = Buffer.from([0x02, 0x01, 0x01]);
  const topIndefinite = Buffer.concat([Buffer.from([0x30, 0x80]), integer, Buffer.from([0x00, 0x00])]);
  const nested = tlv(0x30, Buffer.concat([Buffer.from([0x30, 0x80]), integer, Buffer.from([0x00, 0x00])]));
  let deep = integer;
  for (let index = 0; index < 32; index += 1) deep = tlv(0x30, deep);
  const tooManyNodes = tlv(0x30, Buffer.alloc((limits.maxBerNodes + 1) * 2, 0x00).map((value, index) => index % 2 === 0 ? 0x05 : value));
  const cases = [
    [topIndefinite, 'malformed-cms'],
    [nested, 'malformed-cms'],
    [Buffer.concat([Buffer.from([0x30, 0x80]), integer]), 'malformed-cms'],
    [Buffer.from([0x30, 0x02, 0x04, 0x80]), 'malformed-cms'],
    [Buffer.from([0x30, 0x00, 0xff]), 'malformed-cms'],
    [Buffer.from([0x30, 0x81, 0x00]), 'malformed-cms'],
    [Buffer.from([0x30, 0x02, 0x00, 0x00]), 'malformed-cms'],
    [deep, 'resource-limit'],
    [tooManyNodes, 'resource-limit'],
  ];
  for (const [cms, expected] of cases) {
    await writeFile(join(dumps, 'input.pdf.sig0'), cms, { mode: 0o600 });
    await stageRequest(path, pdf, [record(0, cms)]);
    const { response, text } = run(path);
    assert.equal(response.result.records[0].certificateChain.reason, expected, text);
    assert.notEqual(response.result.records[0].certificateChain.reason, 'unsupported-cms-encoding');
  }
});

test('detached CMS status rejects a signature over different ByteRange bytes', async (t) => {
  const original = Buffer.from('abcdefgh');
  const path = await workspace(t, original);
  const dumps = join(path, 'dumps');
  await mkdir(dumps, { mode: 0o700 });
  const detached = Buffer.from('abcfgh');
  const detachedPath = join(path, 'detached.bin');
  const key = join(path, 'fixture-key.pem');
  const certificate = join(path, 'fixture-cert.pem');
  const cmsPath = join(dumps, 'input.pdf.sig0');
  await writeFile(detachedPath, detached, { mode: 0o600 });
  let generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', certificate,
    '-nodes', '-subj', '/CN=PDF Signature Trust Fixture', '-days', '1',
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  generated = spawnSync('openssl', [
    'cms', '-sign', '-binary', '-in', detachedPath, '-signer', certificate, '-inkey', key,
    '-outform', 'DER', '-out', cmsPath, '-md', 'sha256',
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  await chmod(cmsPath, 0o600);
  const cms = await readFile(cmsPath);
  const signedRecord = record(0, cms, { byteRange: [0, 3, 5, 3] });
  await stageRequest(path, original, [signedRecord]);
  let result = run(path);
  assert.notEqual(result.response.result.records[0].certificateChain.reason, 'cms-signature-mismatch', result.text);
  assert.notEqual(result.response.result.records[0].certificateChain.status, 'passes', 'self-signed fixture must not be trusted');

  const modified = Buffer.from('zbcdefgh');
  await writeFile(join(path, 'input.pdf'), modified, { mode: 0o600 });
  await stageRequest(path, modified, [signedRecord]);
  result = run(path);
  assert.equal(result.response.result.records[0].certificateChain.status, 'indeterminate');
  assert.equal(result.response.result.records[0].certificateChain.reason, 'cms-signature-mismatch');
  assert.doesNotMatch(result.text, /fixture-key|fixture-cert|detached\.bin|input\.pdf\.sig0/u);
});
