import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizePdfBatesNumbering, PDF_BATES_NUMBERING_PROFILE } from '../scripts/host/pdf-bates-numbering-contract.mjs';
import { inspectPdfBatesNumbering, writePdfBatesNumbering } from '../scripts/host/pdf-bates-numbering-writer.mjs';
function source() { const b = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']; let x = '%PDF-1.7\n'; const o=[]; for(let i=0;i<b.length;i+=1){o.push(Buffer.byteLength(x));x+=`${i+1} 0 obj\n${b[i]}\nendobj\n`;} const sx=Buffer.byteLength(x); x+=`xref\n0 5\n0000000000 65535 f \n${o.map(v=>`${String(v).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${sx}\n%%EOF\n`; return Buffer.from(x,'latin1'); }
function req(s, extra={}) { return { profile: PDF_BATES_NUMBERING_PROFILE, sourceSha256: createHash('sha256').update(s).digest('hex'), pages:[1], start:1, prefix:'', suffix:'', padding:3, position:'bottom-left', margin:12, fontSize:10, ...extra }; }
function encryptedSource() { const original = source().toString('latin1'); const split = original.indexOf('xref\n'); const body = original.slice(0, split); const encryption = '5 0 obj\n<< /Filter /Standard /V 1 /Length 40 /R 2 /O <0000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000> >>\nendobj\n'; const fullBody = body + encryption; const offsets = []; for (let object = 1; object <= 5; object += 1) offsets.push(fullBody.indexOf(`${object} 0 obj`)); const xrefOffset = Buffer.byteLength(fullBody, 'latin1'); const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`; return Buffer.from(fullBody + xref, 'latin1'); }
test('Bates contract and writer reject malformed requests and preserve source prefix', () => { const s=source(); const p=writePdfBatesNumbering(s,req(s)); assert.equal(p.proof.revisionCount,2); assert.equal(p.proof.resourceName,'BatesHelv'); assert.equal(p.bytes.subarray(0,s.length).equals(s),true); const inspected = inspectPdfBatesNumbering(s,p.bytes,req(s)); assert.equal(inspected.outputSha256,p.proof.outputSha256); assert.deepEqual(inspected.pages,p.proof.pages.map(({ page, text }) => ({ page, text }))); assert.throws(()=>normalizePdfBatesNumbering(req(s,{pages:[1,1]})),{code:'INVALID_PDF_BATES_NUMBERING'}); assert.throws(()=>normalizePdfBatesNumbering(req(s,{position:'middle'})),{code:'INVALID_PDF_BATES_NUMBERING'}); });
test('Bates writer rejects hostile text, geometry, encryption, and font collisions', () => { const s=source(); assert.throws(()=>writePdfBatesNumbering(s,req(s,{prefix:'\uE000'})),{code:'INVALID_PDF_BATES_NUMBERING'}); assert.throws(()=>writePdfBatesNumbering(s,req(s,{margin:1_000_001})),{code:'INVALID_PDF_BATES_NUMBERING'}); const encrypted=encryptedSource(); assert.throws(()=>writePdfBatesNumbering(encrypted,req(encrypted)),{code:'UNSUPPORTED_PDF_BATES_NUMBERING_SOURCE'}); const collision=Buffer.from(s.toString('latin1').replace('/Resources << >>','/Resources << /Font << /BatesHelv 9 0 R >> >>'),'latin1'); assert.throws(()=>writePdfBatesNumbering(collision,req(collision)),{code:'UNSUPPORTED_PDF_BATES_NUMBERING_SOURCE'}); });
test('Bates contract and independent inspection reject descriptor and output tampering', () => { const s=source(); const base=req(s); const getterPages=[]; Object.defineProperty(getterPages,'0',{get(){return 1;},enumerable:true}); Object.defineProperty(getterPages,'length',{value:1}); assert.throws(()=>normalizePdfBatesNumbering({...base,pages:getterPages}),{code:'INVALID_PDF_BATES_NUMBERING'}); const symbolPages=[1]; symbolPages[Symbol('extra')]=true; assert.throws(()=>normalizePdfBatesNumbering({...base,pages:symbolPages}),{code:'INVALID_PDF_BATES_NUMBERING'}); const built=writePdfBatesNumbering(s,base); const tampered=Buffer.from(built.bytes); const marker=Buffer.from('303031','latin1'); const at=tampered.lastIndexOf(marker); assert.ok(at > s.length); tampered[at + 5] = '2'.charCodeAt(0); assert.throws(()=>inspectPdfBatesNumbering(s,tampered,base),{code:'INVALID_PDF_BATES_NUMBERING_OUTPUT'}); });
test('Bates writer rejects indirect font and nested resource aliases', () => { const s=source(); const indirectFont=Buffer.from(s.toString('latin1').replace('/Resources << >>','/Resources << /Font 9 0 R >>'),'latin1'); assert.throws(()=>writePdfBatesNumbering(indirectFont,req(indirectFont)),{code:'UNSUPPORTED_PDF_BATES_NUMBERING_SOURCE'}); const indirectResource=Buffer.from(s.toString('latin1').replace('/Resources << >>','/Resources << /XObject << /Im0 9 0 R >> >>'),'latin1'); assert.throws(()=>writePdfBatesNumbering(indirectResource,req(indirectResource)),{code:'UNSUPPORTED_PDF_BATES_NUMBERING_SOURCE'}); });

function assertInvalid(value, message = 'The Bates-numbering request is invalid.') { assert.throws(() => normalizePdfBatesNumbering(value), { code: 'INVALID_PDF_BATES_NUMBERING', message }); }

test('Bates normalization returns an exact immutable value for valid plain and proxy requests', () => {
  const s = source();
  const input = req(s, { pages: [1, 3, 5], start: 7, prefix: 'B-', suffix: '-Z', padding: 4, position: 'top-right', margin: 0, fontSize: 200 });
  const expected = { ...input, pages: [1, 3, 5] };
  const normalized = normalizePdfBatesNumbering(input);
  assert.deepEqual(normalized, expected);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.pages));
  assert.throws(() => { normalized.pages.push(6); }, TypeError);
  assert.deepEqual(normalizePdfBatesNumbering(new Proxy(input, {})), expected);
  assert.deepEqual(normalizePdfBatesNumbering(req(s, { pages: Object.freeze([1]) })), req(s));

  let pageReads = 0;
  const changingPages = new Proxy(req(s), {
    get(target, key, receiver) {
      if (key !== 'pages') return Reflect.get(target, key, receiver);
      pageReads += 1;
      return pageReads === 5 ? [] : [1];
    },
  });
  assertInvalid(changingPages);

  pageReads = 0;
  const changingPredecessor = new Proxy(req(s, { pages: [1, 2] }), {
    get(target, key, receiver) {
      if (key !== 'pages') return Reflect.get(target, key, receiver);
      pageReads += 1;
      return pageReads === 10 ? [100] : [1, 2];
    },
  });
  assertInvalid(changingPredecessor);

  let marginReads = 0;
  const changingMargin = new Proxy(req(s), {
    get(target, key, receiver) {
      if (key !== 'margin') return Reflect.get(target, key, receiver);
      marginReads += 1;
      return marginReads === 3 ? -1 : target.margin;
    },
  });
  assertInvalid(changingMargin);

  let fontSizeReads = 0;
  const changingFontSize = new Proxy(req(s), {
    get(target, key, receiver) {
      if (key !== 'fontSize') return Reflect.get(target, key, receiver);
      fontSizeReads += 1;
      return fontSizeReads === 3 ? 0 : target.fontSize;
    },
  });
  assertInvalid(changingFontSize);
});

test('Bates normalization preserves its hostile-surface, page, and scalar validation contract', () => {
  const s = source(); const base = req(s);
  assertInvalid(null);
  assertInvalid(Object.assign(Object.create(null), base));
  assertInvalid(Object.assign(Object.create({}), base));
  const accessor = { ...base }; Object.defineProperty(accessor, 'profile', { enumerable: true, get: () => base.profile }); assertInvalid(accessor);
  const symbol = { ...base }; symbol[Symbol('extra')] = true; assertInvalid(symbol);
  const nonEnumerable = { ...base }; Object.defineProperty(nonEnumerable, 'extra', { value: true }); assertInvalid(nonEnumerable);
  assertInvalid({ ...base, extra: true });
  assertInvalid({ ...base, pages: {} });
  const prototypePages = [1]; Object.setPrototypeOf(prototypePages, null); assertInvalid({ ...base, pages: prototypePages });
  assertInvalid({ ...base, pages: [, 1] });
  const accessorPages = []; Object.defineProperty(accessorPages, '0', { enumerable: true, get: () => 1 }); Object.defineProperty(accessorPages, 'length', { value: 1 }); assertInvalid({ ...base, pages: accessorPages });
  const nonEnumerablePage = [1]; Object.defineProperty(nonEnumerablePage, '0', { enumerable: false }); assertInvalid({ ...base, pages: nonEnumerablePage });
  const symbolPages = [1]; symbolPages[Symbol('extra')] = true; assertInvalid({ ...base, pages: symbolPages });
  const extraPage = [1]; extraPage.extra = true; assertInvalid({ ...base, pages: extraPage });
  for (const pages of [[0], [501], [Number.MAX_SAFE_INTEGER], [1, 1], [2, 1]]) assertInvalid({ ...base, pages });
  for (const sourceSha256 of ['', 'A'.repeat(64), 'a'.repeat(63)]) assertInvalid({ ...base, sourceSha256 });
  for (const start of [-1, 1.5, 1_000_000_000]) assertInvalid({ ...base, start });
  assertInvalid({ ...base, start: 999_999_999, pages: [1, 2] });
  for (const padding of [0, 13, 1.5]) assertInvalid({ ...base, padding });
  assertInvalid({ ...base, position: 'middle' });
  for (const margin of [-1, Infinity, 1_000_001]) assertInvalid({ ...base, margin });
  for (const fontSize of [0, Infinity, 201]) assertInvalid({ ...base, fontSize });
  assertInvalid({ ...base, prefix: '\uE000' }, 'prefix and suffix must be bounded printable ASCII text.');
  assertInvalid({ ...base, suffix: 'a'.repeat(65) }, 'prefix and suffix must be bounded printable ASCII text.');
});
