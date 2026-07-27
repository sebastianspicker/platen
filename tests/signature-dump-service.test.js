import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  dumpEmbeddedSignatures,
  MAX_SIGNATURE_DUMP_BYTES,
  MAX_SIGNATURE_DUMP_TOTAL_BYTES,
} from '../scripts/host/signature-dump-service.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { runProcess } from '../scripts/host/process-runner.mjs';

const MISMATCHED_PDF_BYTES = 33_556_060;
const ACTUAL_CONTENTS_BYTES = 16 * 1024 * 1024;
const BYTE_RANGE_SLOT_BYTES = 64;
const ascii = (value) => Buffer.from(value, 'ascii');

function mismatchedByteRangePopplerFixture() {
  const chunks = [];
  const offsets = [];
  let bodyLength = 0;
  const push = (chunk) => {
    chunks.push(chunk);
    bodyLength += chunk.length;
  };
  const addObject = (number, body) => {
    offsets.push(bodyLength);
    push(ascii(`${number} 0 obj\n${body}\nendobj\n`));
  };

  push(Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
  addObject(1, '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>');
  addObject(2, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>');
  addObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  addObject(
    4,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R '
      + '/Annots [7 0 R] >>',
  );
  addObject(5, '<< /Length 0 >>\nstream\n\nendstream');
  addObject(6, '<< /Fields [7 0 R] /SigFlags 3 >>');

  const fieldName = '0123456789ABCDEF0123456789ABCDEF';
  offsets.push(bodyLength);
  push(ascii('7 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /T '));
  const decoyStart = bodyLength;
  push(ascii(`(${fieldName})`));
  const decoyEnd = bodyLength;
  push(ascii(' /Rect [0 0 0 0] /P 4 0 R /V 8 0 R >>\nendobj\n'));

  offsets.push(bodyLength);
  push(ascii(
    '8 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite '
      + '/SubFilter /adbe.pkcs7.detached /Contents <',
  ));
  push({ length: ACTUAL_CONTENTS_BYTES * 2, fill: 0x30 });
  push(ascii('> /ByteRange ['));
  const byteRangeSlotStart = bodyLength;
  push(ascii(' '.repeat(BYTE_RANGE_SLOT_BYTES)));
  push(ascii('] >>\nendobj\n'));

  const xrefTail = (xrefOffset) => ascii([
    'xref',
    `0 ${offsets.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${offsets.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n'));
  const unpaddedTail = xrefTail(bodyLength);
  const paddingBytes = MISMATCHED_PDF_BYTES - bodyLength - unpaddedTail.length;
  assert.ok(paddingBytes >= 0);
  const tail = xrefTail(bodyLength + paddingBytes);
  assert.equal(tail.length, unpaddedTail.length);

  const bytes = Buffer.allocUnsafe(MISMATCHED_PDF_BYTES);
  let cursor = 0;
  for (const chunk of chunks) {
    if (Buffer.isBuffer(chunk)) chunk.copy(bytes, cursor);
    else bytes.fill(chunk.fill, cursor, cursor + chunk.length);
    cursor += chunk.length;
  }
  bytes.fill(0x20, cursor, cursor + paddingBytes);
  cursor += paddingBytes;
  tail.copy(bytes, cursor);
  cursor += tail.length;
  assert.equal(cursor, MISMATCHED_PDF_BYTES);

  const byteRange = Object.freeze([0, decoyStart, decoyEnd, MISMATCHED_PDF_BYTES - decoyEnd]);
  const rangeText = byteRange.join(' ');
  assert.ok(rangeText.length <= BYTE_RANGE_SLOT_BYTES);
  ascii(rangeText.padEnd(BYTE_RANGE_SLOT_BYTES, ' ')).copy(bytes, byteRangeSlotStart);
  return Object.freeze({
    bytes,
    actualContentsBytes: ACTUAL_CONTENTS_BYTES,
    signatures: Object.freeze([Object.freeze({
      byteRange,
      signatureType: 'adbe.pkcs7.detached',
    })]),
  });
}

function signatureFixture(contents) {
  const chunks = [Buffer.from('%PDF-1.7\n')];
  const spans = [];
  let offset = chunks[0].length;
  for (const cms of contents) {
    const padding = Buffer.alloc(16, 0x20);
    const token = Buffer.from(`<${cms.toString('hex')}>`, 'ascii');
    chunks.push(padding, token);
    offset += padding.length;
    spans.push({ start: offset, end: offset + token.length });
    offset += token.length;
  }
  chunks.push(Buffer.alloc(32, 0x20));
  const bytes = Buffer.concat(chunks);
  const records = spans.map(({ start, end }) => Object.freeze({
    byteRange: Object.freeze([0, start, end, bytes.length - end]),
    signatureType: 'adbe.pkcs7.detached',
  }));
  return Object.freeze({ bytes, signatures: Object.freeze(records) });
}

const standardFixture = signatureFixture([
  Buffer.from('30800000', 'hex'),
  Buffer.from('3003020101', 'hex'),
]);
const signatures = Object.freeze(standardFixture.signatures.map((signature, index) => Object.freeze({
  ...signature,
  signatureType: index === 0 ? 'adbe.pkcs7.detached' : 'ETSI.CAdES.detached',
})));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'signature-dump-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dumps = join(root, 'dumps');
  const nss = join(root, 'nss');
  await Promise.all([mkdir(dumps, { mode: 0o700 }), mkdir(nss, { mode: 0o700 })]);
  await chmod(root, 0o700);
  const input = join(root, 'input.pdf');
  await writeFile(input, standardFixture.bytes, { mode: 0o600 });
  return { root, dumps, nss, input };
}

test('signature dump binds a complete fixed Poppler inventory to bounded private CMS digests', async (t) => {
  const paths = await workspace(t);
  const cms = [Buffer.from('30800000', 'hex'), Buffer.from('3003020101', 'hex')];
  const calls = [];
  const result = await dumpEmbeddedSignatures({
    async execute(operation, parameters, options) {
      calls.push({ operation, parameters, options });
      assert.equal((await stat(paths.dumps)).mode & 0o777, 0o500);
      for (let index = 0; index < cms.length; index += 1) {
        const metadata = await stat(join(paths.dumps, `input.pdf.sig${index}`));
        assert.equal(metadata.isFIFO(), true);
        assert.equal(metadata.mode & 0o777, 0o600);
        assert.equal(metadata.size, 0);
      }
      await Promise.all(cms.map((bytes, index) => writeFile(join(paths.dumps, `input.pdf.sig${index}`), bytes)));
      return {
        stdout: [
          'Dumping Signatures: 2',
          'Signature #0 (4 bytes) => input.pdf.sig0',
          'Signature #1 (5 bytes) => input.pdf.sig1',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    },
  }, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'dumpSignatures');
  assert.deepEqual(calls[0].parameters, { input: paths.input, nssDirectory: paths.nss });
  assert.equal(calls[0].options.cwd, paths.dumps);
  assert.equal(result.length, 2);
  assert.equal(result[0].cmsFilename, 'dumps/input.pdf.sig0');
  assert.match(result[0].cmsSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result[1].byteRange, signatures[1].byteRange);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0].byteRange), true);
});

test('signature dump rejects holes, unexpected files, links, and size disagreements', async (t) => {
  for (const scenario of ['hole', 'unexpected', 'hardlink', 'size']) {
    const paths = await workspace(t);
    const adapter = {
      async execute() {
        if (scenario === 'hardlink') {
          const target = join(paths.root, 'target.cms');
          await writeFile(target, Buffer.from('30800000', 'hex'));
          await link(target, join(paths.dumps, 'input.pdf.sig0'));
        } else {
          await writeFile(join(paths.dumps, 'input.pdf.sig0'), Buffer.from('30800000', 'hex'));
        }
        if (scenario === 'unexpected') await writeFile(join(paths.dumps, 'extra.bin'), Buffer.from('x'));
        const line = scenario === 'hole'
          ? 'Cannot dump signature #0'
          : `Signature #0 (${scenario === 'size' ? 5 : 4} bytes) => input.pdf.sig0`;
        return { stdout: `Dumping Signatures: 1\n${line}\n`, stderr: '', exitCode: 0 };
      },
    };
    await assert.rejects(dumpEmbeddedSignatures(adapter, {
      input: paths.input,
      nssDirectory: paths.nss,
      dumpDirectory: paths.dumps,
      signatures: signatures.slice(0, 1),
    }), { code: 'SIGNATURE_DUMP_INVALID', status: 502 });
  }
});

test('signature dump rejects declared files above the per-CMS bound before reading them', async (t) => {
  const paths = await workspace(t);
  await assert.rejects(dumpEmbeddedSignatures({
    async execute() {
      return {
        stdout: `Dumping Signatures: 1\nSignature #0 (${MAX_SIGNATURE_DUMP_BYTES + 1} bytes) => input.pdf.sig0\n`,
        stderr: '',
        exitCode: 0,
      };
    },
  }, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures: signatures.slice(0, 1),
  }), { code: 'SIGNATURE_DUMP_INVALID' });
});

test('signature dump rejects an oversized encoded Contents token before starting Poppler', async (t) => {
  const paths = await workspace(t);
  const oversizedFixture = signatureFixture([Buffer.alloc(MAX_SIGNATURE_DUMP_BYTES + 1, 0x30)]);
  await writeFile(paths.input, oversizedFixture.bytes, { mode: 0o600 });
  let executions = 0;
  await assert.rejects(dumpEmbeddedSignatures({
    async execute() { executions += 1; throw new Error('must not execute'); },
  }, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures: oversizedFixture.signatures,
  }), { code: 'SIGNATURE_DUMP_INVALID' });
  assert.equal(executions, 0);
});

test('signature dump hard-bounds a rapid single-file writer without creating a regular dump', async (t) => {
  const paths = await workspace(t);
  const chunkBytes = 64 * 1024;
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync('input.pdf.sig0', Buffer.alloc(${MAX_SIGNATURE_DUMP_BYTES + chunkBytes}));
    process.stdout.write('Dumping Signatures: 1\\nSignature #0 (${MAX_SIGNATURE_DUMP_BYTES + chunkBytes} bytes) => input.pdf.sig0\\n');
  `;
  await assert.rejects(dumpEmbeddedSignatures({
    execute(_operation, _parameters, options) {
      return runProcess({ executable: process.execPath, args: ['-e', script], ...options });
    },
  }, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures: signatures.slice(0, 1),
    timeoutMs: 5_000,
  }), (error) => {
    assert.equal(error?.code, 'SIGNATURE_DUMP_INVALID');
    assert.equal(error?.status, 502);
    assert.equal(
      error?.cause?.code,
      'SIGNATURE_DUMP_INVALID',
      'the live byte guard, rather than the engine timeout, must terminate capture',
    );
    return true;
  });
  assert.deepEqual(await readdir(paths.dumps), [], 'bounded pipe bytes must never become a regular dump');
});

test('signature dump hard-bounds aggregate pipe capture without creating regular dumps', async (t) => {
  const paths = await workspace(t);
  const aggregateFixture = signatureFixture(
    Array.from({ length: 9 }, () => Buffer.from('30800000', 'hex')),
  );
  const signatureSet = aggregateFixture.signatures;
  await writeFile(paths.input, aggregateFixture.bytes, { mode: 0o600 });
  const script = `
    const fs = require('node:fs');
    for (let index = 0; index < 8; index += 1) fs.writeFileSync('input.pdf.sig' + index, Buffer.alloc(${MAX_SIGNATURE_DUMP_BYTES}));
    fs.writeFileSync('input.pdf.sig8', Buffer.alloc(2));
  `;
  await assert.rejects(dumpEmbeddedSignatures({
    execute(_operation, _parameters, options) {
      return runProcess({ executable: process.execPath, args: ['-e', script], ...options });
    },
  }, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures: signatureSet,
    timeoutMs: 5_000,
  }), { code: 'SIGNATURE_DUMP_INVALID', status: 502 });
  assert.deepEqual(await readdir(paths.dumps), [], 'aggregate pipe bytes must never become regular dumps');
});

test('signature dump preserves external cancellation and removes its fixed FIFO inventory', async (t) => {
  const paths = await workspace(t);
  const controller = new AbortController();
  const script = 'setInterval(() => {}, 1_000);';
  const verification = dumpEmbeddedSignatures({
    execute(_operation, _parameters, options) {
      return runProcess({ executable: process.execPath, args: ['-e', script], ...options });
    },
  }, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures: signatures.slice(0, 1),
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => controller.abort(new Error('caller cancelled')), 25);
  await assert.rejects(verification, { code: 'ENGINE_CANCELLED' });
  assert.deepEqual(await readdir(paths.dumps), []);
});

test('installed Poppler cannot turn a mismatched ByteRange gap into an oversized regular dump', {
  timeout: 15_000,
}, async (t) => {
  const registry = new EngineRegistry();
  try {
    await registry.probe('pdfsig');
  } catch (error) {
    if (error?.code === 'ENGINE_NOT_FOUND') {
      t.skip('Installed Poppler pdfsig is unavailable.');
      return;
    }
    throw error;
  }

  const paths = await workspace(t);
  const fixture = mismatchedByteRangePopplerFixture();
  const [firstOffset, firstLength, secondOffset] = fixture.signatures[0].byteRange;
  assert.equal(fixture.bytes.length, MISMATCHED_PDF_BYTES);
  assert.equal(
    secondOffset - (firstOffset + firstLength),
    34,
    'the admitted gap is only the widget field-name string',
  );
  assert.equal(fixture.actualContentsBytes, ACTUAL_CONTENTS_BYTES);
  await writeFile(paths.input, fixture.bytes, { mode: 0o600 });

  const poppler = new PopplerAdapter({ registry });
  let executions = 0;
  let childCancellation = null;
  const installedAdapter = {
    async execute(operation, parameters, options) {
      executions += 1;
      try {
        return await poppler.execute(operation, parameters, options);
      } catch (error) {
        childCancellation = {
          childCode: error?.code,
          aborted: options.signal.aborted,
          reasonCode: options.signal.reason?.code,
        };
        throw error;
      }
    },
  };

  await assert.rejects(dumpEmbeddedSignatures(installedAdapter, {
    input: paths.input,
    nssDirectory: paths.nss,
    dumpDirectory: paths.dumps,
    signatures: fixture.signatures,
    timeoutMs: 5_000,
  }), { code: 'SIGNATURE_DUMP_INVALID', status: 502 });
  assert.equal(executions, 1, 'the installed Poppler dump must actually start');
  assert.deepEqual(childCancellation, {
    childCode: 'ENGINE_CANCELLED',
    aborted: true,
    reasonCode: 'SIGNATURE_DUMP_INVALID',
  });
  assert.deepEqual(await readdir(paths.dumps), [], 'oversized pipe bytes must never become regular dump files');
  assert.equal((await stat(paths.dumps)).mode & 0o777, 0o700);
});
