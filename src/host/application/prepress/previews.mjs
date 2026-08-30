import { basename, join } from 'node:path';
import { boundedRenderDpi, cancelled, dpi, evidence, fail, page } from './prepress-support.mjs';

async function renderOverprint(core, context, documentId, selectedPage, selectedDpi, effectiveDpi) {
  const { sourcePath, workspace, runOptions, checkWorkspace } = context;
  const output = join(workspace, 'overprint.png');
  await core.ghostscript.execute('renderOverprintPreview', {
    input: sourcePath,
    output,
    workspace,
    page: selectedPage,
    dpi: effectiveDpi,
  }, { ...runOptions(), maxStdoutBytes: 256 * 1024, maxStderrBytes: 256 * 1024 });
  await checkWorkspace();
  await core.assertInventory(workspace, new Set(['source.pdf', 'overprint.png']));
  return Object.freeze({
    kind: 'overprint-preview',
    document: Object.freeze({ id: documentId, sha256: core.store.getDocument(documentId).sha256 }),
    page: selectedPage,
    requestedDpi: selectedDpi,
    effectiveDpi,
    image: await core.readPreview(output, 'overprint'),
    evidence: evidence('renderOverprintPreview', 'ghostscript', [
      'Preview is raster simulation only; it does not certify overprint, trapping, separations, or RIP behavior.',
    ]),
  });
}

async function renderSeparationImages(core, context, tiffs) {
  const { workspace, runOptions, checkWorkspace } = context;
  const images = [];
  let totalSourceBytes = 0;
  for (const [index, name] of tiffs.entries()) {
    const input = join(workspace, name);
    const output = join(workspace, `separation-preview-${index + 1}.png`);
    const source = await core.assertRegular(input);
    if (source.size < 1 || source.size > core.limits.maxSeparationSourceBytes) {
      fail('PREPRESS_OUTPUT_LIMIT', 'A separation raster exceeds the local source limit.', 413);
    }
    totalSourceBytes += source.size;
    if (totalSourceBytes > core.limits.maxTotalSeparationSourceBytes) {
      fail('PREPRESS_OUTPUT_LIMIT', 'Separation rasters exceed the local total source limit.', 413);
    }
    await core.validateTiff(input);
    await core.imageMagick.execute('tiffPreview', {
      input,
      output,
      workspace,
      maxDimension: Math.min(4096, core.limits.maxRasterDimension),
    }, { ...runOptions(), maxStdoutBytes: 128 * 1024, maxStderrBytes: 256 * 1024 });
    await checkWorkspace();
    await core.assertInventory(workspace, new Set([
      'source.pdf',
      ...tiffs,
      ...Array.from({ length: index + 1 }, (_, item) => `separation-preview-${item + 1}.png`),
    ]));
    images.push(await core.readPreview(output, basename(name).replace(/\.tiff?$/iu, '')));
  }
  return images;
}

async function renderSeparations(core, context, documentId, selectedPage, selectedDpi, effectiveDpi) {
  const { sourcePath, workspace, signal, runOptions, checkWorkspace } = context;
  const prefix = join(workspace, 'separation.tif');
  await core.ghostscript.execute('renderSeparations', {
    input: sourcePath,
    output: prefix,
    workspace,
    page: selectedPage,
    dpi: effectiveDpi,
  }, { ...runOptions(), maxStdoutBytes: 512 * 1024, maxStderrBytes: 512 * 1024 });
  await checkWorkspace();
  cancelled(signal);
  const tiffs = (await core.listWorkspace(workspace))
    .filter((name) => /^separation(?:\([A-Za-z0-9 ._+-]{1,64}\))?[.]tiff?$/u.test(name))
    .sort();
  if (!tiffs.length || tiffs.length > core.limits.maxSeparationFiles) {
    fail('SEPARATION_OUTPUT_INVALID', 'Ghostscript did not produce a bounded separation set.', 502);
  }
  await core.assertInventory(workspace, new Set(['source.pdf', ...tiffs]));
  const images = await renderSeparationImages(core, context, tiffs);
  if (images.reduce((size, image) => size + Buffer.byteLength(image.data, 'base64'), 0) >
    core.limits.maxTotalPreviewBytes) {
    fail('PREPRESS_OUTPUT_LIMIT', 'Separation previews exceed the local output limit.', 413);
  }
  return Object.freeze({
    kind: 'separation-preview',
    document: Object.freeze({ id: documentId, sha256: core.store.getDocument(documentId).sha256 }),
    page: selectedPage,
    requestedDpi: selectedDpi,
    effectiveDpi,
    images: Object.freeze(images),
    evidence: evidence('renderSeparations', 'ghostscript+imagemagick', [
      'Separation TIFFs are converted to bounded PNG review images; this is not ICC, spot-ink, trapping, ink-limit, or RIP certification.',
    ]),
  });
}

export function createPreviewOperations(core) {
  async function render(documentId, requestedPage, requestedDpi, externalSignal, kind) {
    return core.withSource(documentId, externalSignal, async (context) => {
      const selectedPage = page(requestedPage, Math.min(context.info.pageCount, core.limits.maxPreviewPage));
      const selectedDpi = dpi(requestedDpi, core.limits);
      const effectiveDpi = boundedRenderDpi(
        await core.pdf.inspectPage(documentId, selectedPage, { signal: context.signal }),
        selectedDpi,
        core.limits,
      );
      if (kind === 'overprint') {
        return renderOverprint(core, context, documentId, selectedPage, selectedDpi, effectiveDpi);
      }
      return renderSeparations(core, context, documentId, selectedPage, selectedDpi, effectiveDpi);
    });
  }
  return Object.freeze({
    renderSeparations: (documentId, options = {}) => render(
      documentId, options.page ?? 1, options.dpi ?? 144, options.signal, 'separations',
    ),
    renderOverprintPreview: (documentId, options = {}) => render(
      documentId, options.page ?? 1, options.dpi ?? 144, options.signal, 'overprint',
    ),
  });
}
