import { basename, extname, join } from 'node:path';
import { createOperationProvenance } from '../operation-provenance.mjs';
import { digestFile, fail, recipeUuid } from './prepress-support.mjs';

const stem = (name) => basename(
  String(name ?? 'document.pdf'),
  extname(String(name ?? 'document.pdf')),
).slice(0, 180) || 'document';

function cmykRecipe(document, stagedProfile) {
  return Object.freeze({
    operation: 'ghostscript-icc-cmyk-v1',
    sourceSha256: document.sha256,
    profileSha256: stagedProfile.descriptor.sha256,
    engineVersion: stagedProfile.engine.version,
    compatibility: '1.7',
    renderingIntent: 'relative-colorimetric',
    blackPointCompensation: true,
    preserveSeparations: true,
    overrideEmbeddedIcc: false,
    downsampling: false,
  });
}

function cmykProvenance(documentId, document, profile, validation, pageCount) {
  return createOperationProvenance({
    type: 'ghostscript-icc-cmyk',
    inputs: [{ documentId, sha256: document.sha256, role: 'source' }],
    parameters: {
      profileId: profile.id,
      profileSha256: profile.sha256,
      renderingIntent: 'relative-colorimetric',
      blackPointCompensation: true,
      preserveSeparations: true,
      overrideEmbeddedIcc: false,
    },
    expected: { pageCount, outputColorSpace: 'CMYK-targeted', rasterized: false },
    validation: {
      passed: true,
      validators: [
        'source-sha256', 'icc-header-and-tags', 'icc-profile-sha256',
        'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes',
        'poppler-passive-content', 'poppler-text-equivalence',
        'poppler-render-all-pages', 'artifact-sha256',
      ],
      outputSha256: validation.outputSha256,
      pageCount: validation.pageCount,
      textSha256: validation.textSha256,
    },
  });
}

export function createCmykConversionOperation(core) {
  return async function convertToCmyk(documentId, {
    profile = 'ghostscript-default-cmyk',
    signal,
  } = {}) {
    if (profile !== 'ghostscript-default-cmyk') {
      fail('INVALID_ICC_PROFILE', 'Only the fixed Ghostscript default CMYK profile is available.');
    }
    core.assertArtifactStack({ icc: true });
    return core.withSource(documentId, signal, async ({
      document, sourcePath, info, workspace, signal: jobSignal, runOptions, checkWorkspace,
      registerPromotedArtifact,
    }) => {
      core.assertArtifactSource(info);
      const structure = await core.artifactStructure(documentId, info.pageCount, jobSignal);
      const stagedProfile = await core.profiles.stageDefaultCmyk(workspace);
      await checkWorkspace();
      await core.assertInventory(workspace, new Set(['source.pdf', 'default-cmyk.icc']));
      const recipe = cmykRecipe(document, stagedProfile);
      const outputPath = join(workspace, 'cmyk-normalized.pdf');
      await core.ghostscript.execute('normalizeCmykWithIcc', {
        input: sourcePath,
        output: outputPath,
        workspace,
        outputIccProfile: stagedProfile.path,
        documentUuid: recipeUuid(recipe),
        instanceUuid: recipeUuid({ ...recipe, instance: 'derived-output' }),
      }, { ...runOptions(), maxStdoutBytes: 256 * 1024, maxStderrBytes: 512 * 1024 });
      await checkWorkspace();
      await core.assertInventory(workspace, new Set([
        'source.pdf', 'default-cmyk.icc', 'cmyk-normalized.pdf',
      ]));
      if (await digestFile(stagedProfile.path) !== stagedProfile.descriptor.sha256) {
        fail('ICC_PROFILE_CHANGED', 'The staged CMYK profile changed during conversion.', 502);
      }
      const validation = await core.validateDerivedPdf({
        sourcePath,
        outputPath,
        expectedPageCount: info.pageCount,
        expectedPageBoxes: structure.pageBoxes,
        workspace,
        allowedFiles: ['source.pdf', 'default-cmyk.icc', 'cmyk-normalized.pdf'],
        signal: jobSignal,
      });
      const provenance = cmykProvenance(
        documentId,
        document,
        stagedProfile.descriptor,
        validation,
        info.pageCount,
      );
      const artifact = await core.store.promotePdfArtifact(documentId, outputPath, {
        displayName: `${stem(document.displayName)}-cmyk.pdf`,
        operation: provenance,
        expectedSha256: validation.outputSha256,
        signal: jobSignal,
      });
      registerPromotedArtifact(artifact);
      if (artifact.sha256 !== validation.outputSha256) {
        fail('PREPRESS_ARTIFACT_CHANGED', 'The retained CMYK artifact did not match the validated output.', 500);
      }
      return Object.freeze({
        kind: 'icc-cmyk-artifact',
        schemaVersion: 1,
        sourceDigest: document.sha256,
        artifact,
        profile: stagedProfile.descriptor,
        recipe: Object.freeze({
          colorConversionStrategy: 'CMYK',
          renderingIntent: 'relative-colorimetric',
          blackPointCompensation: true,
          preservesSeparationAndDeviceN: true,
          overrideEmbeddedIcc: false,
          downsampling: false,
        }),
        receipt: Object.freeze({
          engine: stagedProfile.engine,
          outputSha256: validation.outputSha256,
          pageCount: validation.pageCount,
          pageGeometryPreserved: true,
          textExtractionEquivalent: true,
          everyPageRendered: true,
          outputIntentEmbeddedOrValidated: false,
          pdfXValidated: false,
        }),
        authoritative: false,
        limitations: Object.freeze([
          'This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.',
          'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.',
          'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.',
        ]),
      });
    });
  };
}
