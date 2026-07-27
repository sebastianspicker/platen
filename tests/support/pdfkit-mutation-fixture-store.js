import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../../scripts/host/host-error.mjs';
import {
  documentId,
  sourceBytes,
  sourceDigest,
} from './pdfkit-mutation-fixture-data.js';

export function createPdfKitMutationFixtureStore(context) {
  return {
    getDocument: () => ({
      id: documentId,
      sha256: sourceDigest,
      size: sourceBytes.length,
      displayName: 'source.pdf',
    }),
    getSourcePath: () => context.sourcePath,
    verifySource: async () => {
      context.verified += 1;
      const digest = createHash('sha256')
        .update(await readFile(context.sourcePath))
        .digest('hex');
      if (digest !== sourceDigest) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'Source fixture changed.', 500);
      }
    },
    createJobWorkspace: async () => {
      const workspace = await mkdtemp(join(context.root, 'job-'));
      await chmod(workspace, 0o700);
      return workspace;
    },
    cleanupJob: async (workspace) => {
      context.cleaned = true;
      await rm(workspace, { recursive: true, force: true });
    },
    promotePdfArtifact: async (_id, outputPath, options) => {
      context.promoted = { output: await readFile(outputPath), options };
      return {
        id: '22222222-2222-4222-8222-222222222222',
        documentId,
        displayName: options.displayName,
        mediaType: 'application/pdf',
        size: context.promoted.output.length,
        sha256: createHash('sha256').update(context.promoted.output).digest('hex'),
        operation: options.operation,
      };
    },
  };
}
