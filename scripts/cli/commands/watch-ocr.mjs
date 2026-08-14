import { basename, join } from 'node:path';
import {
  canonicalWatchDirectory,
  pruneWatchState,
  snapshotPdfDirectory,
  stablePdfCandidates,
} from '../../host/watch-folder.mjs';

const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_PAGES = 200;
const TERMINAL_ERROR_CODES = new Set([
  'JOB_CANCELLED',
  'ENGINE_HOST_UNHEALTHY',
  'PROCESS_REAP_FAILED',
  'WATCH_SESSION_LIMIT',
]);

function successfulRecord(sequence, candidate, targetName, document, inspection, artifact, result) {
  return Object.freeze({
    sequence,
    ok: true,
    input: candidate.name,
    output: targetName,
    pages: inspection.pageCount,
    inputSha256: document.sha256,
    outputSha256: artifact.sha256,
    size: artifact.size,
    recognizedWordCount: result.recognizedWordCount,
    suspectCount: result.suspects.length,
  });
}

function failedRecord(sequence, candidate, error) {
  return Object.freeze({
    sequence,
    ok: false,
    input: candidate.name,
    error: Object.freeze({
      code: error?.code ?? 'WATCH_OCR_FAILED',
      message: error?.message ?? 'Local watch-folder OCR failed.',
    }),
  });
}

async function processCandidate({
  application,
  command,
  candidate,
  sequence,
  outputDirectory,
  totals,
  signal,
  runtime,
}) {
  const {
    uploadPdf,
    copyExclusive,
    fail,
    safeBatchStem,
  } = runtime;
  let document = null;
  try {
    if (totals.inputBytes + candidate.size > MAX_INPUT_BYTES) {
      fail(
        'WATCH_SESSION_LIMIT',
        `Watch OCR is limited to ${MAX_INPUT_BYTES} aggregate input bytes.`,
      );
    }
    document = await uploadPdf(application, candidate.path, signal);
    const inspection = await application.service.inspect(document.id, { signal });
    if (totals.pages + inspection.pageCount > MAX_PAGES) {
      fail(
        'WATCH_SESSION_LIMIT',
        `Watch OCR is limited to ${MAX_PAGES} aggregate pages.`,
      );
    }
    const { artifact, result } = await application.service.ocrDocument(document.id, {
      language: command.language,
      cleanupPreset: command.cleanupPreset,
      segmentation: command.segmentation,
      signal,
    });
    if (totals.outputBytes + artifact.size > MAX_OUTPUT_BYTES) {
      fail(
        'WATCH_SESSION_LIMIT',
        `Watch OCR is limited to ${MAX_OUTPUT_BYTES} aggregate output bytes.`,
      );
    }

    const targetName = [
      safeBatchStem(candidate.name, sequence - 1),
      document.sha256.slice(0, 12),
      'searchable-ocr.pdf',
    ].join('-');
    const artifactPath = application.store.getArtifact(artifact.id).filePath;
    await copyExclusive(artifactPath, join(outputDirectory, targetName));
    totals.inputBytes += candidate.size;
    totals.outputBytes += artifact.size;
    totals.pages += inspection.pageCount;
    return {
      record: successfulRecord(
        sequence,
        candidate,
        targetName,
        document,
        inspection,
        artifact,
        result,
      ),
      failure: null,
    };
  } catch (error) {
    return {
      record: failedRecord(sequence, candidate, error),
      failure: TERMINAL_ERROR_CODES.has(error?.code) ? error : null,
    };
  } finally {
    if (document && typeof application.store.deleteDocument === 'function') {
      await application.store.deleteDocument(document.id).catch(() => {});
    }
  }
}

async function publishEvent(outputDirectory, stdout, record, runtime) {
  const sequence = String(record.sequence).padStart(4, '0');
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await runtime.writeExclusive(join(outputDirectory, `event-${sequence}.json`), bytes);
  await runtime.emitCompact(stdout, record);
}

function createManifest(command, inputDirectory, totals, results, failure) {
  return Object.freeze({
    kind: 'watch-ocr',
    localOnly: true,
    complete: !failure && (command.once || results.length >= command.maxFiles),
    stoppedBy: failure?.code ?? (command.once ? 'once' : 'max-files'),
    inputDirectory: basename(inputDirectory),
    attempted: results.length,
    inputBytes: totals.inputBytes,
    outputBytes: totals.outputBytes,
    pageCount: totals.pages,
    results: Object.freeze(results),
  });
}

export async function runWatchOcr(application, command, stdout, signal, runtime) {
  const inputDirectory = await canonicalWatchDirectory(command.inputDirectory);
  const outputDirectory = await runtime.createExclusiveOutputDirectory(
    command.outputDirectory,
    { disallowOverlapWith: [inputDirectory] },
  );
  const processed = new Map();
  const results = [];
  const totals = { inputBytes: 0, outputBytes: 0, pages: 0 };
  let previous = await snapshotPdfDirectory(inputDirectory);
  let failure = null;

  try {
    await runtime.waitFor(command.settleMs, signal);
    while (results.length < command.maxFiles) {
      runtime.cancelled(signal);
      const current = await snapshotPdfDirectory(inputDirectory);
      pruneWatchState(processed, current);
      const candidates = stablePdfCandidates(
        previous,
        current,
        processed,
        command.maxFiles - results.length,
      );
      for (const candidate of candidates) {
        processed.set(candidate.name, candidate.signature);
        const sequence = results.length + 1;
        const outcome = await processCandidate({
          application,
          command,
          candidate,
          sequence,
          outputDirectory,
          totals,
          signal,
          runtime,
        });
        failure = outcome.failure;
        results.push(outcome.record);
        await publishEvent(outputDirectory, stdout, outcome.record, runtime);
        if (failure || results.length >= command.maxFiles) {
          break;
        }
      }
      if (failure || command.once || results.length >= command.maxFiles) {
        break;
      }
      previous = current;
      await runtime.waitFor(command.intervalMs, signal);
    }
  } catch (error) {
    failure = error;
  }

  const manifest = createManifest(command, inputDirectory, totals, results, failure);
  await runtime.writeExclusive(
    join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await runtime.emitCompact(stdout, manifest);
  if (failure) {
    throw failure;
  }
}
