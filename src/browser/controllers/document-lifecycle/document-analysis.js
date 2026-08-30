const MAX_ARRANGEABLE_PAGES = 500;
const MAX_THUMBNAIL_PAGES = 24;
const THUMBNAIL_CONCURRENCY = 4;

function unavailableSignatureEvidence() {
  return {
    status: 'indeterminate',
    integrityStatus: 'indeterminate',
    coverageStatus: 'indeterminate',
    currentDocumentStatus: 'indeterminate',
    count: null,
    signatureCount: null,
    signatures: [],
    limitations: [
      'Certificate trust, signer identity, revocation, and timestamps were not checked.',
    ],
  };
}

async function mapLimited(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await operation(values[index]);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    worker,
  ));
  return results.filter(Boolean);
}

function applyEvidenceResults(context, results) {
  const { state, syncAecRecordIds, syncRedactionPlans } = context;
  const [text, fonts, images, attachments, signatures, structure, workspace] = results;
  state.analysis.textPages = text.status === 'fulfilled' ? text.value : [];
  state.analysis.fonts = fonts.status === 'fulfilled' ? fonts.value : [];
  state.analysis.images = images.status === 'fulfilled' ? images.value : [];
  state.analysis.attachments = attachments.status === 'fulfilled' ? attachments.value : [];
  state.analysis.signatures = signatures.status === 'fulfilled'
    ? signatures.value
    : unavailableSignatureEvidence();
  state.analysis.structure = structure.status === 'fulfilled' ? structure.value : null;
  state.domainRevision = workspace.status === 'fulfilled' ? workspace.value.revision : 0;
  if (workspace.status === 'fulfilled') {
    syncAecRecordIds(workspace.value);
    syncRedactionPlans(workspace.value);
  }
}

async function loadEvidence(context, hosted, inspection, signal) {
  const { client } = context;
  return Promise.allSettled([
    client.text(hosted.id, inspection.pageCount, { signal }),
    client.fonts(hosted.id, { signal }),
    client.images(hosted.id, { signal }),
    client.attachments(hosted.id, { signal }),
    client.signatures(hosted.id, { signal }),
    client.inspectStructure(hosted.id, {
      firstPage: 1,
      lastPage: Math.min(inspection.pageCount, MAX_ARRANGEABLE_PAGES),
      signal,
    }),
    client.workspace(hosted.id, { signal }),
  ]);
}

async function loadThumbnails(context, hosted, inspection, signal) {
  const { client, urlApi } = context;
  const pages = Array.from(
    { length: Math.min(inspection.pageCount, MAX_THUMBNAIL_PAGES) },
    (_, index) => index + 1,
  );
  let thumbnailFailure = null;
  const thumbnails = await mapLimited(pages, THUMBNAIL_CONCURRENCY, async (page) => {
    try {
      const blob = await client.thumbnail(hosted.id, page, 84, { signal });
      return { page, url: urlApi.createObjectURL(blob) };
    } catch (error) {
      thumbnailFailure ??= error;
      return null;
    }
  });
  return { thumbnails, thumbnailFailure };
}

async function analyzeHostedDocument(context, hosted, operationGeneration, signal) {
  const {
    state,
    client,
    lifecycle,
    render,
    announce,
    revokeThumbnails,
    updateSearchResults,
  } = context;
  state.analysis.documentId = hosted.id;
  state.analysis.sha256 = hosted.sha256;
  state.analysis.progress = 'Inspecting PDF structure…';
  render();

  const inspection = await client.inspect(hosted.id, { signal });
  if (operationGeneration !== lifecycle.generation) return;
  state.analysis.inspection = inspection;
  state.pdfkitMetadata = Object.fromEntries(
    ['title', 'author', 'subject', 'keywords'].map((key) => [
      key,
      typeof inspection[key] === 'string' ? inspection[key] : '',
    ]),
  );
  state.pageOrder = inspection.pageCount <= MAX_ARRANGEABLE_PAGES
    ? Array.from({ length: inspection.pageCount }, (_, index) => index + 1)
    : [];
  state.analysis.progress = 'Extracting text and auditing resources…';
  render();

  const results = await loadEvidence(context, hosted, inspection, signal);
  if (operationGeneration !== lifecycle.generation) return;
  applyEvidenceResults(context, results);
  state.analysis.progress = 'Rendering bounded page thumbnails…';
  render();

  const { thumbnails, thumbnailFailure } = await loadThumbnails(
    context,
    hosted,
    inspection,
    signal,
  );
  if (operationGeneration !== lifecycle.generation) {
    revokeThumbnails(thumbnails);
    return;
  }
  state.analysis.thumbnails = thumbnails;
  state.analysis.thumbnailNotice = thumbnailFailure
    ? `One or more thumbnails were not rendered: ${thumbnailFailure.message}`
    : null;
  state.analysis.status = 'ready';
  state.analysis.progress = null;
  updateSearchResults();
  announce(
    `Local analysis complete. ${inspection.pageCount} page${inspection.pageCount === 1 ? '' : 's'} ready.`,
  );
  render();
  if (operationGeneration === lifecycle.generation) {
    lifecycle.analysisController = null;
  }
}

async function analyzeFile(context, file, operationGeneration, signal) {
  const {
    state,
    client,
    lifecycle,
    connectLocalHost,
    removeHostDocument,
    render,
    announce,
  } = context;
  try {
    await connectLocalHost();
    if (operationGeneration !== lifecycle.generation) return;
    state.analysis.progress = 'Copying into the private local session…';
    render();
    const hosted = await client.upload(file, { signal });
    if (operationGeneration !== lifecycle.generation) {
      await removeHostDocument(hosted.id);
      return;
    }
    await analyzeHostedDocument(context, hosted, operationGeneration, signal);
  } catch (error) {
    if (operationGeneration !== lifecycle.generation) return;
    lifecycle.analysisController = null;
    state.analysis.status = 'error';
    state.analysis.progress = null;
    state.error = `The PDF is open for browser preview, but local analysis failed: ${error.message}`;
    announce(state.error);
    render();
  }
}

export function createDocumentAnalysisController(options) {
  const context = { ...options };
  return Object.freeze({
    analyzeFile: (file, generation, signal) => analyzeFile(
      context,
      file,
      generation,
      signal,
    ),
  });
}
