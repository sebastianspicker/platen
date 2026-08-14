import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const MAX_VERIFIED_OUTPUT_BYTES = 256 * 1024 * 1024;

function fail(runtime, code, message) {
  runtime.fail(code, message);
}

function verifyRetainedArtifact(artifact, bytes, runtime) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== artifact.size || digest !== artifact.sha256) {
    fail(
      runtime,
      'CLI_FAST_WEB_VIEW_ARTIFACT_MISMATCH',
      'The retained fast web-view artifact no longer matches its verified metadata.',
    );
  }
  return digest;
}

export async function runFastWebViewCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  await runtime.canonicalOutputTarget(command.output);
  let result;
  try {
    result = await application.fastWebView.linearize(document.id, {
      profile: 'local-pdf-fast-web-view-v1',
    }, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const artifact = application.store.getArtifact(result.artifact.id);
    if (artifact.size > MAX_VERIFIED_OUTPUT_BYTES) {
      fail(
        runtime,
        'CLI_FAST_WEB_VIEW_ARTIFACT_TOO_LARGE',
        'The fast web-view artifact exceeds the 256 MiB verified publication limit.',
      );
    }
    const retained = await runtime.readLocalInputBytes(artifact.filePath, {
      minimumBytes: 64,
      maximumBytes: MAX_VERIFIED_OUTPUT_BYTES,
      extension: '.pdf',
      signal,
    });
    runtime.cancelled(signal);
    const digest = verifyRetainedArtifact(artifact, retained.bytes, runtime);
    await runtime.writeExclusiveVerified(command.output, retained.bytes, signal, async (receipt) => {
      if (receipt?.size !== artifact.size || receipt.sha256 !== digest) {
        fail(
          runtime,
          'CLI_FAST_WEB_VIEW_RECEIPT_MISMATCH',
          'The published fast web-view receipt does not match the verified artifact.',
        );
      }
      runtime.cancelled(signal);
      await runtime.emit(stdout, {
        ...result,
        artifact: { ...result.artifact, output: basename(command.output) },
        localOnly: true,
      });
    });
  } finally {
    if (result?.artifact?.id) await application.store.deleteArtifact(result.artifact.id).catch(() => {});
  }
}
