import { basename, extname, join } from 'node:path';
import { createOperationProvenance } from '../operation-provenance.mjs';
import { fail, recipeUuid } from './prepress-support.mjs';

const stem = (name) => basename(
  String(name ?? 'document.pdf'),
  extname(String(name ?? 'document.pdf')),
).slice(0, 180) || 'document';

function assertImpositionOptions(layout, marks) {
  if (!Object.hasOwn({ '2x1': true, '2x2': true }, layout)) {
    fail('INVALID_IMPOSITION_LAYOUT', 'Choose the fixed 2x1 or 2x2 N-up layout.');
  }
  if (typeof marks !== 'boolean') fail('INVALID_IMPOSITION_MARKS', 'marks must be a boolean.');
  if (marks) {
    fail('PRINTER_MARKS_UNSUPPORTED', 'The local Ghostscript N-up engine does not provide validated production crop, registration, bleed, or color-bar marks.', 422);
  }
}

function impositionProvenance(documentId, document, layout, geometry, validation) {
  return createOperationProvenance({
    type: 'ghostscript-nup-imposition',
    inputs: [{ documentId, sha256: document.sha256, role: 'source' }],
    parameters: {
      layout: layout.id,
      across: layout.across,
      down: layout.down,
      order: 'upper-left-row-major',
      marks: false,
    },
    expected: {
      pageCount: layout.sheetCount,
      sheetWidthPoints: layout.sheet.widthPoints,
      sheetHeightPoints: layout.sheet.heightPoints,
      rasterized: false,
    },
    validation: {
      passed: true,
      validators: [
        'source-sha256', 'uniform-source-page-geometry', 'ghostscript-exit-zero',
        'poppler-page-count', 'poppler-sheet-geometry', 'poppler-passive-content',
        'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256',
      ],
      outputSha256: validation.outputSha256,
      pageCount: validation.pageCount,
      textSha256: validation.textSha256,
    },
  });
}

export function createImpositionOperation(core) {
  return async function createImposition(documentId, {
    layout = '2x1',
    marks = false,
    signal,
  } = {}) {
    assertImpositionOptions(layout, marks);
    core.assertArtifactStack();
    return core.withSource(documentId, signal, async ({
      document, sourcePath, info, workspace, signal: jobSignal, runOptions, checkWorkspace,
      registerPromotedArtifact,
    }) => {
      core.assertArtifactSource(info);
      const structure = await core.artifactStructure(documentId, info.pageCount, jobSignal);
      const geometry = core.uniformImpositionGeometry(structure.pageBoxes);
      const [across, down] = layout.split('x').map(Number);
      const sheetWidthPoints = Number((geometry.widthPoints * across).toFixed(3));
      const sheetHeightPoints = Number((geometry.heightPoints * down).toFixed(3));
      if (sheetWidthPoints > 14_400 || sheetHeightPoints > 14_400) {
        fail('IMPOSITION_SHEET_TOO_LARGE', 'The fixed N-up sheet would exceed the 14,400-point PDF engine limit.', 422);
      }
      const engine = await core.ghostscript.probe();
      const recipe = Object.freeze({
        operation: 'ghostscript-nup-v1',
        sourceSha256: document.sha256,
        engineVersion: engine.version,
        layout,
        across,
        down,
        sheetWidthPoints,
        sheetHeightPoints,
        order: 'upper-left-row-major',
        marks: false,
      });
      const outputPath = join(workspace, 'imposed.pdf');
      await core.ghostscript.execute('imposeNup', {
        input: sourcePath,
        output: outputPath,
        workspace,
        across,
        down,
        sheetWidthPoints,
        sheetHeightPoints,
        documentUuid: recipeUuid(recipe),
        instanceUuid: recipeUuid({ ...recipe, instance: 'derived-output' }),
      }, { ...runOptions(), maxStdoutBytes: 256 * 1024, maxStderrBytes: 512 * 1024 });
      await checkWorkspace();
      await core.assertInventory(workspace, new Set(['source.pdf', 'imposed.pdf']));
      const expectedPageCount = Math.ceil(info.pageCount / (across * down));
      const sheet = Object.freeze({ widthPoints: sheetWidthPoints, heightPoints: sheetHeightPoints });
      const validation = await core.validateDerivedPdf({
        sourcePath,
        outputPath,
        expectedPageCount,
        expectedSheet: sheet,
        workspace,
        allowedFiles: ['source.pdf', 'imposed.pdf'],
        signal: jobSignal,
      });
      const layoutReceipt = Object.freeze({
        id: layout,
        across,
        down,
        order: 'upper-left-row-major',
        sourcePageCount: info.pageCount,
        sheetCount: expectedPageCount,
        sourcePage: geometry,
        sheet,
        marks: 'none',
      });
      const artifact = await core.store.promotePdfArtifact(documentId, outputPath, {
        displayName: `${stem(document.displayName)}-${layout}-nup.pdf`,
        operation: impositionProvenance(documentId, document, layoutReceipt, geometry, validation),
        expectedSha256: validation.outputSha256,
        signal: jobSignal,
      });
      registerPromotedArtifact(artifact);
      if (artifact.sha256 !== validation.outputSha256) {
        fail('PREPRESS_ARTIFACT_CHANGED', 'The retained imposition artifact did not match the validated output.', 500);
      }
      return Object.freeze({
        kind: 'imposition-artifact',
        schemaVersion: 1,
        sourceDigest: document.sha256,
        artifact,
        layout: layoutReceipt,
        receipt: Object.freeze({
          engine: Object.freeze({ name: 'Ghostscript', version: engine.version }),
          outputSha256: validation.outputSha256,
          pageCount: validation.pageCount,
          vectorOrientedPdfwriteRewrite: true,
          unconditionalVectorPreservationClaim: false,
          textExtractionEquivalent: true,
          everySheetRendered: true,
          pdfXValidated: false,
        }),
        authoritative: false,
        limitations: Object.freeze([
          'This is bounded row-major N-up, not booklet, signature, creep, gutter, step-and-repeat, or production imposition.',
          'Printer marks are unavailable because the installed engine has no validated production marks contract.',
          'Ghostscript writes a new vector-oriented PDF but may rewrite or rasterize unsupported constructs; links, destinations, tags, annotations, forms, optional content, and signatures are not preserved by contract.',
        ]),
      });
    });
  };
}
