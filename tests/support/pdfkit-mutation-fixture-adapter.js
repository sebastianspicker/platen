import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  inspection,
  nativeOutput,
  outputDigest,
  sourceBytes,
  sourceDigest,
} from './pdfkit-mutation-fixture-data.js';

export class PdfKitMutationFixtureAdapter {
  #context;
  #options;

  constructor(context, options) {
    this.#context = context;
    this.#options = options;
  }

  async #stage({ workspacePath, requestPath }, executionOptions, output) {
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    this.#context.observed = {
      workspacePath,
      request,
      inputMode: (await stat(join(workspacePath, 'input.pdf'))).mode & 0o777,
      requestMode: (await stat(requestPath)).mode & 0o777,
      options: executionOptions,
    };
    await writeFile(join(workspacePath, 'output.pdf'), output, { mode: 0o600 });
    if (this.#options.unsafeOutput) {
      await writeFile(join(workspacePath, 'unexpected.txt'), 'unsafe', { mode: 0o600 });
    }
    return request;
  }

  async mutate(invocation, executionOptions) {
    const request = await this.#stage(invocation, executionOptions, nativeOutput);
    const postflight = inspection(this.#options.helperPages);
    if (request.mutation.rotation) {
      postflight.pages[request.mutation.rotation.page - 1].rotation = request.mutation.rotation.degrees;
    }
    if (request.mutation.pageBox?.box === 'crop') {
      postflight.pages[request.mutation.pageBox.page - 1].boxes.crop = {
        ...request.mutation.pageBox.rect,
      };
    }
    if (request.mutation.pageBox?.box === 'bleed') {
      postflight.pages[request.mutation.pageBox.page - 1].boxes.bleed = {
        ...request.mutation.pageBox.rect,
      };
    }
    return {
      schema: 'pdfkit-mutation-receipt-v1',
      version: 1,
      operation: 'mutate',
      category: 'structure-mutation',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(nativeOutput),
      appliedEdits: request.mutation.metadata ? 4 : 1,
      inspection: postflight,
      ...(this.#options.mutationReceiptOverride ?? {}),
    };
  }

  async targetedMutate(invocation, executionOptions) {
    const request = await this.#stage(invocation, executionOptions, nativeOutput);
    const properties = request.mutation.annotationProperties !== null;
    return {
      schema: 'pdfkit-targeted-mutation-receipt-v1',
      version: 1,
      operation: 'targetedMutate',
      category: properties ? 'annotation-properties' : 'targeted-mutation',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(nativeOutput),
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      reopenVerified: true,
      annotationPropertiesGeometryVerified: properties,
      annotationPropertiesColorVerified: properties,
      rawAnnotationColorVerified: properties,
      nonTargetAnnotationsVerified: properties,
      targetAnnotationPreservationVerified: properties,
      ...(this.#options.targetedReceiptOverride ?? {}),
    };
  }

  async addLocalGoToLink(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% local GoTo derived fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-local-goto-receipt-v1',
      version: 1,
      operation: 'addLocalGoToLink',
      category: 'local-goto-link',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      sourcePage: request.link.sourcePage,
      targetPage: request.link.targetPage,
      annotationIndex: 0,
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      rawDestinationVerified: true,
      localGoToActionVerified: true,
      reopenVerified: true,
      ...(this.#options.localReceiptOverride ?? {}),
    };
  }

  async removeLocalGoToLink(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% local GoTo removal fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-local-goto-removal-receipt-v1',
      version: 1,
      operation: 'removeLocalGoToLink',
      category: 'local-goto-link-removal',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      page: request.link.page,
      annotationIndex: request.link.annotationIndex,
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      rawTargetVerified: true,
      annotationRemoved: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
      reopenVerified: true,
      ...(this.#options.localRemovalReceiptOverride ?? {}),
    };
  }

  async appendOutlineBookmark(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% outline bookmark fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-outline-bookmark-receipt-v1',
      version: 1,
      operation: 'appendOutlineBookmark',
      category: 'outline-bookmark',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      labelSha256: outputDigest(Buffer.from(request.bookmark.label, 'utf8')),
      page: request.bookmark.page,
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      outlineAppended: true,
      destinationVerified: true,
      priorOutlineTreeVerified: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
      rawDestinationVerified: true,
      reopenVerified: true,
      ...(this.#options.outlineReceiptOverride ?? {}),
    };
  }

  async removeOutlineBookmark(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% outline bookmark removal fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-outline-removal-receipt-v1',
      version: 1,
      operation: 'removeOutlineBookmark',
      category: 'outline-bookmark-removal',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      topLevelIndex: request.bookmark.topLevelIndex,
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      rawTargetVerified: true,
      outlineRemoved: true,
      remainingOutlineTreeVerified: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
      contentSnapshotVerified: true,
      reopenVerified: true,
      ...(this.#options.outlineRemovalReceiptOverride ?? {}),
    };
  }

  async renameOutlineBookmark(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% outline bookmark rename fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-outline-rename-receipt-v1',
      version: 1,
      operation: 'renameOutlineBookmark',
      category: 'outline-bookmark-rename',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      topLevelIndex: request.bookmarkRename.topLevelIndex,
      labelSha256: outputDigest(Buffer.from(request.bookmarkRename.label, 'utf8')),
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      rawTargetVerified: true,
      outlineRenamed: true,
      remainingOutlineTreeVerified: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
      contentSnapshotVerified: true,
      reopenVerified: true,
      ...(this.#options.outlineRenameReceiptOverride ?? {}),
    };
  }

  async addLineAnnotation(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% inert line annotation fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-line-receipt-v1',
      version: 1,
      operation: 'addLineAnnotation',
      category: 'line-annotation',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      page: request.line.page,
      annotationIndex: 0,
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      geometryVerified: true,
      lineStylesVerified: true,
      reopenVerified: true,
      ...(this.#options.lineReceiptOverride ?? {}),
    };
  }

  async addInkAnnotation(invocation, executionOptions) {
    const output = Buffer.concat([sourceBytes, Buffer.from('\n% inert ink annotation fixture')]);
    const request = await this.#stage(invocation, executionOptions, output);
    return {
      schema: 'pdfkit-ink-receipt-v1',
      version: 1,
      operation: 'addInkAnnotation',
      category: 'ink-annotation',
      sourceSha256: sourceDigest,
      outputSha256: outputDigest(output),
      page: request.ink.page,
      annotationIndex: 0,
      pageCount: this.#options.helperPages,
      appliedEdits: 1,
      geometryVerified: true,
      rawInkListVerified: true,
      reopenVerified: true,
      ...(this.#options.inkReceiptOverride ?? {}),
    };
  }
}
