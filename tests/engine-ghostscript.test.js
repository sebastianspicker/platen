import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGhostscriptCmykNormalizationArgs,
  buildGhostscriptFastWebViewPdfArgs,
  buildGhostscriptFlattenTransparencyArgs,
  buildGhostscriptInkCoverageArgs,
  buildGhostscriptNupImpositionArgs,
  buildGhostscriptOverprintPreviewArgs,
  buildGhostscriptPdfA2Args,
  buildGhostscriptPdfXArgs,
  buildGhostscriptRewritePdfArgs,
  buildGhostscriptSeparationsArgs,
  GhostscriptAdapter,
} from '../scripts/host/adapters/ghostscript.mjs';

const workspace = '/jobs/private';
const documentUuid = 'uuid:12345678-1234-5234-9234-1234567890ab';
const instanceUuid = 'uuid:abcdefab-cdef-5abc-8def-abcdefabcdef';

test('Ghostscript builders construct fixed local PDF rewrite argv', () => {
  assert.deepEqual(buildGhostscriptRewritePdfArgs({ input: '/documents/source.pdf', output: `${workspace}/rewritten.pdf`, workspace }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-sOutputFile=/jobs/private/rewritten.pdf', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptFastWebViewPdfArgs({ input: '/documents/source.pdf', output: `${workspace}/web.pdf`, workspace }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dFastWebView=true', '-sOutputFile=/jobs/private/web.pdf', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptFlattenTransparencyArgs({ input: '/documents/source.pdf', output: `${workspace}/flat.pdf`, workspace }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.3', '-sOutputFile=/jobs/private/flat.pdf', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptPdfA2Args({ input: '/documents/source.pdf', output: `${workspace}/pdfa.pdf`, workspace, outputIccProfile: '/profiles/sRGB.icc' }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dPDFA=2', '-dPDFACompatibilityPolicy=1', '-sColorConversionStrategy=RGB', '-sOutputICCProfile=/profiles/sRGB.icc', '-sOutputFile=/jobs/private/pdfa.pdf', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptPdfXArgs({ input: '/documents/source.pdf', output: `${workspace}/pdfx.pdf`, workspace, outputIccProfile: '/profiles/CMYK.icc' }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dPDFX', '-sColorConversionStrategy=CMYK', '-sOutputICCProfile=/profiles/CMYK.icc', '-sOutputFile=/jobs/private/pdfx.pdf', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptInkCoverageArgs({ input: '/documents/source.pdf', workspace }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=inkcov', '-o', '-', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptSeparationsArgs({
    input: '/documents/source.pdf', output: `${workspace}/separation.tif`, workspace, page: 2, dpi: 96,
  }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=tiffsep', '-dFirstPage=2', '-dLastPage=2', '-r96',
    '-sOutputFile=/jobs/private/separation.tif', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptOverprintPreviewArgs({
    input: '/documents/source.pdf', output: `${workspace}/overprint.png`, workspace, page: 1, dpi: 72,
  }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m', '-sOverprint=simulate', '-dFirstPage=1', '-dLastPage=1', '-r72',
    '-sOutputFile=/jobs/private/overprint.png', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptCmykNormalizationArgs({
    input: '/documents/source.pdf', output: `${workspace}/cmyk.pdf`, workspace,
    outputIccProfile: `${workspace}/default-cmyk.icc`, documentUuid, instanceUuid,
  }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-q',
    '--permit-file-read=/jobs/private/default-cmyk.icc', '-dPDFSTOPONWARNING', '-dPDFNOCIDFALLBACK',
    '-dCompatibilityLevel=1.7', '-dAutoRotatePages=/None', '-dDownsampleColorImages=false',
    '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false', '-dPreserveOverprintSettings=true',
    '-dOverrideICC=false', '-dPreserveSeparation=true', '-sColorConversionStrategy=CMYK',
    '-sBlendConversionStrategy=Simple', '-sOutputICCProfile=/jobs/private/default-cmyk.icc',
    '-dRenderIntent=1', '-dBlackPtComp=1', '-dOmitInfoDate=true', '-dOmitID=true',
    `-sDocumentUUID=${documentUuid}`, `-sInstanceUUID=${instanceUuid}`,
    '-sOutputFile=/jobs/private/cmyk.pdf', '/documents/source.pdf',
  ]);
  assert.deepEqual(buildGhostscriptNupImpositionArgs({
    input: '/documents/source.pdf', output: `${workspace}/nup.pdf`, workspace,
    across: 2, down: 1, sheetWidthPoints: 1224, sheetHeightPoints: 792,
    documentUuid, instanceUuid,
  }), [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-q', '-dPDFSTOPONWARNING',
    '-dPDFNOCIDFALLBACK', '-dCompatibilityLevel=1.7', '-dAutoRotatePages=/None',
    '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
    '-dPreserveOverprintSettings=true', '-dDEVICEWIDTHPOINTS=1224', '-dDEVICEHEIGHTPOINTS=792',
    '-dFIXEDMEDIA', '-sNupControl=2x1', '-dOmitInfoDate=true', '-dOmitID=true',
    `-sDocumentUUID=${documentUuid}`, `-sInstanceUUID=${instanceUuid}`,
    '-sOutputFile=/jobs/private/nup.pdf', '/documents/source.pdf',
  ]);
});

test('Ghostscript builders reject output escapes and path injection', () => {
  assert.throws(() => buildGhostscriptRewritePdfArgs({ input: 'source.pdf', output: `${workspace}/out.pdf`, workspace }), /input must be an absolute path/);
  assert.throws(() => buildGhostscriptRewritePdfArgs({ input: '/documents/source.pdf', output: '/tmp/out.pdf', workspace }), /inside workspace/);
  assert.throws(() => buildGhostscriptRewritePdfArgs({ input: '/documents/source.pdf', output: `${workspace}/out.ps`, workspace }), /.pdf extension/);
  assert.throws(() => buildGhostscriptPdfA2Args({ input: '/documents/source.pdf', output: `${workspace}/out.pdf`, workspace, outputIccProfile: 'profile.icc' }), /outputIccProfile must be an absolute path/);
  assert.throws(() => buildGhostscriptSeparationsArgs({ input: '/documents/source.pdf', output: '/tmp/out.tif', workspace, page: 1, dpi: 96 }), /inside workspace/);
  assert.throws(() => buildGhostscriptOverprintPreviewArgs({ input: '/documents/source.pdf', output: `${workspace}/out.png`, workspace, page: 0, dpi: 96 }), /page must be/);
  assert.throws(() => buildGhostscriptCmykNormalizationArgs({ input: '/documents/source.pdf', output: `${workspace}/out.pdf`, workspace, outputIccProfile: '/profiles/cmyk.icc', documentUuid, instanceUuid }), /inside workspace/);
  assert.throws(() => buildGhostscriptNupImpositionArgs({ input: '/documents/source.pdf', output: `${workspace}/out.pdf`, workspace, across: 1, down: 1, sheetWidthPoints: 612, sheetHeightPoints: 792, documentUuid, instanceUuid }), /2 through 8 cells/);
  assert.throws(() => buildGhostscriptNupImpositionArgs({ input: '/documents/source.pdf', output: `${workspace}/out.pdf`, workspace, across: 2, down: 1, sheetWidthPoints: 1224, sheetHeightPoints: 792, documentUuid: 'not-a-uuid', instanceUuid }), /canonical UUID/);
});

test('Ghostscript adapter pins gs, workspace cwd, and builder argv', async () => {
  const calls = [];
  const adapter = new GhostscriptAdapter({
    registry: { probe: async (name) => ({ name, executable: '/engines/gs' }) },
    runner: async (invocation) => { calls.push(invocation); return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  await adapter.execute('optimizePdf', { input: '/documents/source.pdf', output: `${workspace}/out.pdf`, workspace }, {
    timeoutMs: 10_000, executable: '/untrusted/override', args: ['--unsafe'], cwd: '/untrusted',
  });
  assert.deepEqual(calls, [{
    timeoutMs: 10_000, executable: '/engines/gs', cwd: workspace,
    args: ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/ebook', '-sOutputFile=/jobs/private/out.pdf', '/documents/source.pdf'],
  }]);
  assert.deepEqual(await adapter.probe(), { name: 'Ghostscript', version: undefined });
});
