import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfKitMutationService } from '../../scripts/host/pdfkit-mutation-service.mjs';
import { PdfKitMutationFixtureAdapter } from './pdfkit-mutation-fixture-adapter.js';
import {
  DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS,
  createPdfKitMutationFixturePoppler,
} from './pdfkit-mutation-fixture-poppler.js';
import { createPdfKitMutationFixtureStore } from './pdfkit-mutation-fixture-store.js';
import {
  documentId,
  inspection,
  mutation,
  mutationOptions,
  nativeOutput,
  png,
  sourceBytes,
  sourceDigest,
} from './pdfkit-mutation-fixture-data.js';

async function fixture({ abortAfterPromotion, cleanupFailure, deleteFailure, ...overrides } = {}) {
  const options = { ...DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS, ...overrides };
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-mutation-service-'));
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const context = {
    root,
    sourcePath,
    sourceBackup: `${sourcePath}.before-swap`,
    verified: 0,
    cleaned: false,
    observed: null,
    promoted: null,
    sourceSwapped: false,
    stagedSourcePath: null,
    sourceCalls: [],
    deleted: [],
    abortAfterPromotion,
    cleanupFailure,
    deleteFailure,
  };
  const store = createPdfKitMutationFixtureStore(context);
  const poppler = createPdfKitMutationFixturePoppler(context, options);
  const adapter = new PdfKitMutationFixtureAdapter(context, options);
  const service = new PdfKitMutationService({ store, poppler, adapter });
  return {
    root,
    service,
    state: () => ({
      verified: context.verified,
      cleaned: context.cleaned,
      observed: context.observed,
      promoted: context.promoted,
      sourceSwapped: context.sourceSwapped,
      sourceCalls: context.sourceCalls,
      stagedSourcePath: context.stagedSourcePath,
      deleted: context.deleted,
    }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export {
  documentId,
  fixture,
  inspection,
  mutation,
  mutationOptions,
  nativeOutput,
  png,
  sourceBytes,
  sourceDigest,
};
