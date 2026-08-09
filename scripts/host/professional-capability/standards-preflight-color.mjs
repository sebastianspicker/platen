import { OUTPUT_INTENT_PROFILE } from '../prepress/output-intent-contract.mjs';
import { assembleSpotColorPdf } from './specialist-embed-pdf.mjs';
import { fail, requireString, result, sha256 } from './support.mjs';
import {
  SHA256, abort, authority, boundDocument, retainedBytes, revokeAfterFailure, runtime,
} from './standards-preflight-print-core.mjs';

const FIXED_CMYK_PROFILE = 'ghostscript-default-cmyk';
const CMYK_VALIDATORS = Object.freeze([
  'source-sha256', 'icc-header-and-tags', 'icc-profile-sha256',
  'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes',
  'poppler-passive-content', 'poppler-text-equivalence',
  'poppler-render-all-pages', 'artifact-sha256',
]);
const CMYK_LIMITATIONS = Object.freeze([
  'This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.',
  'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.',
  'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.',
]);

export async function colorConvert(ctx = {}) {
  const requestedProfiles = [ctx.profile, ctx.colorTarget, ctx.target]
    .filter((value) => value !== undefined)
    .map((value) => requireString(value, 'profile', { min: 1, max: 40 }));
  if (requestedProfiles.some((profile) => profile !== FIXED_CMYK_PROFILE)) {
    fail('INVALID_ICC_PROFILE', `Color conversion requires the fixed ${FIXED_CMYK_PROFILE} profile.`, 400);
  }
  const prepress = authority(ctx, 'prepress', 'PrepressService');
  const source = boundDocument(ctx, 'color-conversion source');
  if (typeof prepress.convertToCmyk !== 'function') {
    fail('COLOR_CONVERSION_UNAVAILABLE', 'Color conversion requires the validated prepress service and a source-bound document.', 503);
  }
  let converted;
  try {
    converted = await prepress.convertToCmyk(source.id, {
      profile: FIXED_CMYK_PROFILE,
      signal: ctx.signal,
    });
    const artifact = converted?.artifact;
    const profile = converted?.profile;
    const provenance = artifact?.operation;
    const validation = provenance?.validation;
    const receipt = converted?.receipt;
    if (converted?.kind !== 'icc-cmyk-artifact' || converted?.schemaVersion !== 1
      || converted?.sourceDigest !== source.sha256
      || artifact?.documentId !== source.id
      || typeof converted?.artifact?.id !== 'string'
      || !SHA256.test(converted?.artifact?.sha256 ?? '')
      || !Number.isSafeInteger(converted?.artifact?.size) || converted.artifact.size < 1
      || artifact?.mediaType !== 'application/pdf'
      || profile?.id !== FIXED_CMYK_PROFILE || profile?.colorSpace !== 'CMYK' || !SHA256.test(profile?.sha256 ?? '')
      || provenance?.type !== 'ghostscript-icc-cmyk'
      || provenance?.inputs?.length !== 1 || provenance.inputs[0]?.documentId !== source.id
      || provenance.inputs[0]?.sha256 !== source.sha256 || provenance.inputs[0]?.role !== 'source'
      || provenance?.parameters?.profileId !== profile.id || provenance.parameters?.profileSha256 !== profile.sha256
      || provenance.parameters?.renderingIntent !== 'relative-colorimetric'
      || provenance.parameters?.blackPointCompensation !== true || provenance.parameters?.preserveSeparations !== true
      || provenance.parameters?.overrideEmbeddedIcc !== false
      || !Number.isSafeInteger(provenance?.expected?.pageCount) || provenance.expected.pageCount < 1
      || provenance.expected?.outputColorSpace !== 'CMYK-targeted' || provenance.expected?.rasterized !== false
      || validation?.passed !== true || validation?.outputSha256 !== artifact.sha256
      || !Number.isSafeInteger(validation?.pageCount) || validation.pageCount < 1 || !SHA256.test(validation?.textSha256 ?? '')
      || !Array.isArray(validation?.validators) || CMYK_VALIDATORS.some((validator) => !validation.validators.includes(validator))
      || receipt?.outputSha256 !== artifact.sha256 || receipt?.pageCount !== validation.pageCount
      || receipt?.pageGeometryPreserved !== true || receipt?.textExtractionEquivalent !== true
      || receipt?.everyPageRendered !== true || receipt?.outputIntentEmbeddedOrValidated !== false || receipt?.pdfXValidated !== false
      || converted?.authoritative !== false || !Array.isArray(converted?.limitations)
      || CMYK_LIMITATIONS.some((limitation) => !converted.limitations.includes(limitation))) {
      fail('COLOR_CONVERSION_SERVICE_INVALID', 'The prepress service returned an invalid source-bound CMYK artifact.', 502);
    }
    abort(ctx.signal);
    const retained = await retainedBytes(runtime(ctx).store, 'artifact', converted.artifact.id,
      converted.artifact.sha256, 'COLOR_CONVERSION_ARTIFACT_REVOKED', converted.artifact.size);
    retained.fill(0);
  } catch (error) {
    if (converted?.artifact?.id) return revokeAfterFailure(runtime(ctx).store, 'artifact', converted.artifact.id, error);
    throw error;
  }
  return result('color.convert', {
    method: 'validated-prepress-cmyk-service', documentId: source.id,
    sourceSha256: converted.sourceDigest, targetProfile: FIXED_CMYK_PROFILE,
    artifactId: converted.artifact.id, outputSha256: converted.artifact.sha256,
    profile: converted.profile, recipe: converted.recipe, receipt: converted.receipt,
    authoritative: converted.authoritative, limitations: converted.limitations,
    serviceEvidence: converted.serviceEvidence, serviceBound: true, converted: true,
    mediaType: converted.artifact.mediaType ?? 'application/pdf',
  });
}

export async function colorOutputIntents(ctx = {}) {
  const prepress = authority(ctx, 'prepress', 'PrepressService');
  const source = boundDocument(ctx, 'OutputIntent source');
  if (typeof prepress.assignOutputIntent !== 'function') {
    fail('OUTPUT_INTENT_UNAVAILABLE', 'OutputIntent assignment requires the validated prepress service and a source-bound document.', 503);
  }
  let assigned;
  let pdf;
  try {
    assigned = await prepress.assignOutputIntent(source.id, {
      profile: OUTPUT_INTENT_PROFILE,
      sourceSha256: source.sha256,
    }, { signal: ctx.signal });
    const artifact = assigned?.artifact;
    const profile = assigned?.profile;
    const proof = assigned?.proof;
    const receipt = assigned?.receipt;
    const provenance = artifact?.operation;
    if (assigned?.kind !== 'output-intent-artifact'
      || assigned?.sourceDigest !== source.sha256
      || artifact?.documentId !== source.id || typeof artifact?.id !== 'string' || !SHA256.test(artifact?.sha256 ?? '')
      || !Number.isSafeInteger(artifact?.size) || artifact.size < 1
      || profile?.id !== FIXED_CMYK_PROFILE || profile?.colorSpace !== 'CMYK'
      || !SHA256.test(profile?.sha256 ?? '') || !Number.isSafeInteger(profile?.size) || profile.size < 132
      || proof?.schema !== 'pdf-output-intent-assignment-proof-v1'
      || proof?.sourceSha256 !== source.sha256 || proof?.outputSha256 !== artifact.sha256
      || proof?.profileSha256 !== profile.sha256 || proof?.profileBytes !== profile.size
      || proof?.outputIntentCount !== 1 || proof?.closedClassicRevision !== true || proof?.priorRevisionsAbsent !== true
      || receipt?.outputSha256 !== artifact.sha256 || receipt?.outputIntentCount !== 1
      || receipt?.pageGeometryPreserved !== true || receipt?.textExtractionEquivalent !== true
      || receipt?.everyPageRendered !== true || receipt?.pdfXValidated !== false
      || provenance?.type !== 'ghostscript-cmyk-output-intent'
      || provenance?.inputs?.length !== 1 || provenance.inputs[0]?.documentId !== source.id
      || provenance?.inputs[0]?.sha256 !== source.sha256 || provenance?.inputs[0]?.role !== 'source'
      || provenance?.parameters?.profileId !== profile.id || provenance.parameters?.profileSha256 !== profile.sha256
      || provenance?.parameters?.profileBytes !== profile.size || provenance?.parameters?.outputIntentSubtype !== 'GTS_PDFX'
      || provenance?.expected?.embeddedProfileSha256 !== profile.sha256 || provenance.expected?.outputIntentCount !== 1
      || provenance?.validation?.passed !== true || provenance.validation?.outputSha256 !== artifact.sha256
      || provenance.validation?.profileSha256 !== profile.sha256) {
      fail('OUTPUT_INTENT_SERVICE_INVALID', 'The prepress service returned an incoherent OutputIntent artifact.', 502);
    }
    abort(ctx.signal);
    pdf = await retainedBytes(runtime(ctx).store, 'artifact', artifact.id, artifact.sha256,
      'OUTPUT_INTENT_ARTIFACT_REVOKED', artifact.size);
  } catch (error) {
    if (assigned?.artifact?.id) return revokeAfterFailure(runtime(ctx).store, 'artifact', assigned.artifact.id, error);
    throw error;
  }
  const { artifact, profile, proof, receipt } = assigned;
  return result('color.output-intents', {
    method: 'validated-prepress-output-intent-service', profile: OUTPUT_INTENT_PROFILE,
    descriptor: Object.freeze({ type: 'GTS_PDFX', profileId: profile.id, profileSha256: profile.sha256, profileBytes: profile.size, colorSpace: profile.colorSpace }),
    applied: true, artifactId: artifact.id, outputSha256: artifact.sha256,
    profileSha256: profile.sha256, profileBytes: profile.size, proof, receipt,
    pdf, bytes: pdf.length,
  });
}

export function colorSpotColors(ctx = {}) {
  const spots = Array.isArray(ctx.spots) ? ctx.spots : [{ name: 'PANTONE 185 C', cmyk: [0, 0.91, 0.76, 0] }];
  const built = assembleSpotColorPdf({ spots: spots.slice(0, 50) });
  if (!built.bytes.toString('latin1').includes('/Separation')) fail('SPOT_COLOR_MISSING', 'Separation color space missing from PDF.', 502);
  return result('color.spot-colors', {
    method: 'local-color-spot-separation-apply', spots: built.spots, count: built.count,
    applied: true, outputSha256: sha256(built.bytes), pdf: built.bytes, bytes: built.bytes.length,
  });
}
