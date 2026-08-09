import { HostError } from '../host-error.mjs';
import { buildPdfCompactRewrite } from '../pdf-compact-rewrite.mjs';
import {
  digest,
  factoryFromContext,
  result,
  sourcePdfBytes,
} from './create-convert-lib.mjs';

export async function optimizeCompress(context = {}) {
  const factory = factoryFromContext(context);
  if (typeof context?.conversion?.rewriteDocument === 'function' && context?.documentId) {
    const document = await context.conversion.rewriteDocument(context.documentId, 'optimize', {
      signal: context.signal,
    });
    return result('optimize.compress', {
      documentId: document.id,
      pageCount: document.operation?.validation?.pageCount,
      size: document.size,
      sha256: document.sha256,
      operationType: document.operation?.type,
      mediaType: 'application/pdf',
    });
  }
  const source = sourcePdfBytes(context, factory);
  const rewritten = buildPdfCompactRewrite(source);
  const reduced = rewritten.bytes.length < source.length;
  const bytes = reduced ? rewritten.bytes : source;
  return result('optimize.compress', {
    bytes,
    size: bytes.length,
    originalSize: source.length,
    savedBytes: source.length - bytes.length,
    reduced,
    sha256: digest(bytes),
    pageCount: context.pageCount ?? 1,
    mediaType: 'application/pdf',
    reachableObjectCount: rewritten.summary.reachableObjectCount,
    sourceSha256: digest(source),
    path: 'buildPdfCompactRewrite',
  });
}

export async function optimizeFastWebView(context = {}) {
  if (typeof context?.fastWebView?.linearize !== 'function'
    || typeof context?.documentId !== 'string' || context.documentId.length === 0
    || typeof context?.sourceSha256 !== 'string' || context.sourceSha256.length === 0) {
    throw new HostError(
      'FAST_WEB_VIEW_UNAVAILABLE',
      'Fast web view requires the validated qpdf service and a source-bound document.',
      503,
    );
  }
  const linearized = await context.fastWebView.linearize(context.documentId, {
    profile: 'local-pdf-fast-web-view-v1',
  }, { sourceSha256: context.sourceSha256, signal: context.signal });
  return result('optimize.fast-web-view', {
    artifactId: linearized.artifact?.id ?? null,
    sourceDigest: linearized.sourceDigest,
    engine: linearized.engine,
    evidence: linearized.evidence,
    limitations: linearized.limitations,
    linearized: true,
    mediaType: 'application/pdf',
    path: 'validated-qpdf-service',
  });
}
