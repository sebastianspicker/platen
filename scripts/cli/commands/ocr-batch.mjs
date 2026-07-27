const MAX_PAGES = 50;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const TERMINAL_ERROR_CODES = new Set([
  'JOB_CANCELLED',
  'ENGINE_HOST_UNHEALTHY',
  'PROCESS_REAP_FAILED',
  'PREPRESS_CLEANUP_FAILED',
]);

function pathName(path) {
  return path.split(/[\\/]/u).pop();
}

async function uploadInputs(application, command, signal, runtime, totals) {
  const uploaded = [];
  for (const input of command.inputs) {
    const document = await runtime.uploadPdf(application, input, signal);
    const inspection = await application.service.inspect(document.id, { signal });
    totals.pages += inspection.pageCount;
    totals.inputBytes += document.size;
    if (totals.pages > MAX_PAGES) {
      runtime.fail(
        'CLI_BATCH_LIMIT',
        `Batch OCR is limited to ${MAX_PAGES} total pages.`,
      );
    }
    if (totals.inputBytes > MAX_INPUT_BYTES) {
      runtime.fail(
        'CLI_BATCH_LIMIT',
        `Batch OCR is limited to ${MAX_INPUT_BYTES} aggregate input bytes.`,
      );
    }
    uploaded.push({ input, document, inspection });
  }
  return uploaded;
}

async function createTargets(uploaded, outputDirectory, runtime) {
  const targets = [];
  for (const [index, item] of uploaded.entries()) {
    const stem = runtime.safeBatchStem(item.document.displayName, index);
    const target = `${outputDirectory}/${stem}-searchable-ocr.pdf`;
    await runtime.canonicalOutputTarget(target);
    targets.push(target);
  }
  return targets;
}

function successfulResult(item, target, artifact, result) {
  return Object.freeze({
    ok: true,
    input: pathName(item.input),
    output: pathName(target),
    pages: item.inspection.pageCount,
    size: artifact.size,
    sha256: artifact.sha256,
    recognizedWordCount: result.recognizedWordCount,
    suspectCount: result.suspects.length,
    language: result.language,
    cleanupPreset: result.cleanupPreset,
    segmentation: result.segmentation,
  });
}

function failedResult(item, error) {
  return Object.freeze({
    ok: false,
    input: pathName(item.input),
    pages: item.inspection.pageCount,
    error: Object.freeze({
      code: error?.code ?? 'OCR_FAILED',
      message: error?.message ?? 'Local OCR failed.',
    }),
  });
}

async function processItem(
  application,
  command,
  item,
  target,
  totals,
  signal,
  runtime,
) {
  try {
    runtime.cancelled(signal);
    const { artifact, result } = await application.service.ocrDocument(
      item.document.id,
      {
        language: command.language,
        cleanupPreset: command.cleanupPreset,
        segmentation: command.segmentation,
        signal,
      },
    );
    if (totals.outputBytes + artifact.size > MAX_OUTPUT_BYTES) {
      runtime.fail(
        'CLI_BATCH_LIMIT',
        `Batch OCR is limited to ${MAX_OUTPUT_BYTES} aggregate output bytes.`,
      );
    }
    runtime.cancelled(signal);
    const artifactPath = application.store.getArtifact(artifact.id).filePath;
    await runtime.copyExclusive(artifactPath, target);
    totals.outputBytes += artifact.size;
    return {
      result: successfulResult(item, target, artifact, result),
      terminal: false,
    };
  } catch (error) {
    return {
      result: failedResult(item, error),
      terminal: TERMINAL_ERROR_CODES.has(error?.code),
    };
  }
}

function createManifest(uploaded, results, totals) {
  return Object.freeze({
    kind: 'ocr-batch',
    localOnly: true,
    complete: results.length === uploaded.length && results.every(({ ok }) => ok),
    fileCount: uploaded.length,
    attempted: results.length,
    pageCount: totals.pages,
    inputBytes: totals.inputBytes,
    outputBytes: totals.outputBytes,
    results: Object.freeze(results),
  });
}

export async function runBatchOcr(application, command, stdout, signal, runtime) {
  const totals = { pages: 0, inputBytes: 0, outputBytes: 0 };
  const uploaded = await uploadInputs(application, command, signal, runtime, totals);
  const outputDirectory = await runtime.createExclusiveOutputDirectory(
    command.outputDirectory,
  );
  const targets = await createTargets(uploaded, outputDirectory, runtime);
  const results = [];

  for (const [index, item] of uploaded.entries()) {
    const outcome = await processItem(
      application,
      command,
      item,
      targets[index],
      totals,
      signal,
      runtime,
    );
    results.push(outcome.result);
    if (outcome.terminal) {
      break;
    }
  }

  const manifest = createManifest(uploaded, results, totals);
  await runtime.writeExclusive(
    `${outputDirectory}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await runtime.emit(stdout, manifest);
  if (!manifest.complete) {
    runtime.fail(
      'CLI_BATCH_PARTIAL',
      'Batch OCR completed with one or more recorded failures.',
    );
  }
}
