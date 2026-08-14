import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_PAGE_BACKGROUND_PROFILE, normalizePdfPageBackground } from '../scripts/host/pdf-page-background-contract.mjs';
import { inspectPdfPageBackground, writePdfPageBackground } from '../scripts/host/pdf-page-background-writer.mjs';

function source() { return makeMultiPagePdf(['one', 'two', 'three'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]], bleedBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]], trimBoxes: [[18, 18, 594, 774], [18, 18, 594, 774], [18, 18, 594, 774]] }); }
function request(bytes, pages = [1, 3]) { return { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: createHash('sha256').update(bytes).digest('hex'), pages, color: { r: 0.1, g: 0.2, b: 0.3 } }; }

test('page-background writer prepends deterministic canonical RGB fills to selected pages', () => {
  const input = source(); const req = request(input); const first = writePdfPageBackground(input, req); const second = writePdfPageBackground(input, req);
  assert.deepEqual(first.bytes, second.bytes); assert.ok(first.bytes.subarray(0, input.length).equals(input)); assert.equal(first.proof.pages.length, 2); assert.equal(first.proof.pages[0].stream.bytes > 0, true); assert.deepEqual(inspectPdfPageBackground(input, first.bytes, req), first.proof);
});

test('page-background rejects malformed selections, rotated pages, and unequal boxes', () => {
  const input = source(); assert.throws(() => writePdfPageBackground(input, request(input, [2, 1])), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  const rotated = makeMultiPagePdf(['one'], { rotations: [90], cropBoxes: [[0, 0, 612, 792]] }); assert.throws(() => writePdfPageBackground(rotated, request(rotated, [1])), { code: 'UNSUPPORTED_PDF_PAGE_BACKGROUND' });
  const unequal = makeMultiPagePdf(['one'], { cropBoxes: [[1, 1, 611, 791]] }); assert.throws(() => writePdfPageBackground(unequal, request(unequal, [1])), { code: 'UNSUPPORTED_PDF_PAGE_BACKGROUND' });
});

test('page-background contract rejects accessors, symbols, extras, and over-precise colors', () => {
  const input = source(); const req = request(input);
  assert.throws(() => normalizePdfPageBackground({ ...req, extra: true }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  assert.throws(() => normalizePdfPageBackground({ ...req, color: { r: 0.0000001, g: 0, b: 0 } }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  const pages = [1]; Object.defineProperty(pages, '0', { get() { return 1; }, enumerable: true }); assert.throws(() => normalizePdfPageBackground({ ...req, pages }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
});

test('page-background contract rejects hostile request and color shapes without reading accessors', () => {
  const input = source(); const req = request(input); const invalid = (value) => assert.throws(() => normalizePdfPageBackground(value), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  class RequestShape { constructor() { Object.assign(this, req); } }
  class ColorShape { constructor() { Object.assign(this, req.color); } }
  invalid(null); invalid(new RequestShape()); invalid(Object.assign(Object.create(null), req));
  const symbolRequest = { ...req }; symbolRequest[Symbol('request')] = true; invalid(symbolRequest);
  const hiddenRequest = { ...req }; delete hiddenRequest.profile; Object.defineProperty(hiddenRequest, 'profile', { value: req.profile }); invalid(hiddenRequest);
  let requestReads = 0; const requestGetter = { ...req }; Object.defineProperty(requestGetter, 'profile', { enumerable: true, get() { requestReads += 1; return req.profile; } }); invalid(requestGetter); assert.equal(requestReads, 0);
  invalid({ ...req, color: null }); invalid({ ...req, color: new ColorShape() }); invalid({ ...req, color: Object.assign(Object.create(null), req.color) });
  const symbolColor = { ...req.color }; symbolColor[Symbol('color')] = true; invalid({ ...req, color: symbolColor });
  const hiddenColor = { ...req.color }; delete hiddenColor.r; Object.defineProperty(hiddenColor, 'r', { value: 0 }); invalid({ ...req, color: hiddenColor });
  let colorReads = 0; const colorGetter = { ...req.color }; Object.defineProperty(colorGetter, 'r', { enumerable: true, get() { colorReads += 1; return 0; } }); invalid({ ...req, color: colorGetter }); assert.equal(colorReads, 0);
});

test('page-background contract rejects sparse, non-data, and unordered page lists', () => {
  const input = source(); const req = request(input); const invalid = (pages) => assert.throws(() => normalizePdfPageBackground({ ...req, pages }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  invalid([1, , 3]); invalid([1, 1]); invalid([2, 1]); invalid([0]); invalid([501]);
  let accessorReads = 0; const accessor = [1]; Object.defineProperty(accessor, '0', { enumerable: true, get() { accessorReads += 1; return 1; } }); invalid(accessor); assert.equal(accessorReads, 0);
  const symbol = [1]; symbol[Symbol('page')] = true; invalid(symbol);
  const hidden = [1]; Object.defineProperty(hidden, 'side', { value: true }); invalid(hidden);
  const extra = [1]; extra.side = true; invalid(extra);
});

test('page-background contract enforces canonical hashes and RGB values', () => {
  const input = source(); const req = request(input); const invalid = (color) => assert.throws(() => normalizePdfPageBackground({ ...req, color }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  assert.throws(() => normalizePdfPageBackground({ ...req, sourceSha256: req.sourceSha256.toUpperCase() }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  assert.deepEqual(normalizePdfPageBackground(req).sourceSha256, req.sourceSha256);
  assert.deepEqual(normalizePdfPageBackground({ color: req.color, pages: req.pages, sourceSha256: req.sourceSha256, profile: req.profile }), normalizePdfPageBackground(req));
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, -0.1, 1.1, 0.1234567]) invalid({ r: value, g: 0, b: 0 });
});

test('page-background contract snapshots to detached frozen data and rejects proxies before traps', () => {
  const input = source(); const req = request(input); const normalized = normalizePdfPageBackground(req);
  assert.equal(Object.isFrozen(normalized), true); assert.equal(Object.isFrozen(normalized.pages), true); assert.equal(Object.isFrozen(normalized.color), true);
  req.pages[0] = 2; req.color.r = 0.9; assert.deepEqual(normalized, { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: req.sourceSha256, pages: [1, 3], color: { r: 0.1, g: 0.2, b: 0.3 } });
  assert.throws(() => { normalized.pages[0] = 2; }, TypeError); assert.throws(() => { normalized.color.r = 0.9; }, TypeError);
  const hostile = (value, calls) => new Proxy(value, { get() { calls.count += 1; throw new Error('trap'); }, getPrototypeOf() { calls.count += 1; throw new Error('trap'); }, ownKeys() { calls.count += 1; throw new Error('trap'); }, getOwnPropertyDescriptor() { calls.count += 1; throw new Error('trap'); } });
  const invalid = (value) => assert.throws(() => normalizePdfPageBackground(value), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  const hostileCalls = [{ count: 0 }, { count: 0 }, { count: 0 }];
  invalid(hostile(request(input), hostileCalls[0])); invalid({ ...request(input), pages: hostile([1], hostileCalls[1]) }); invalid({ ...request(input), color: hostile({ r: 0, g: 0, b: 0 }, hostileCalls[2]) }); assert.deepEqual(hostileCalls, [{ count: 0 }, { count: 0 }, { count: 0 }]);
  const revoked = (value) => { const control = Proxy.revocable(value, {}); control.revoke(); return control.proxy; };
  invalid(revoked(request(input))); invalid({ ...request(input), pages: revoked([1]) }); invalid({ ...request(input), color: revoked({ r: 0, g: 0, b: 0 }) });
});

test('page-background inspection rejects output tampering', () => {
  const input = source(); const req = request(input); const result = writePdfPageBackground(input, req); const tampered = Buffer.from(result.bytes); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => inspectPdfPageBackground(input, tampered, req), { code: 'INVALID_PDF_PAGE_BACKGROUND_OUTPUT' });
});
