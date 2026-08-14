import assert from 'node:assert/strict';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  inspectedPageOutput,
  png,
  sourceBytes,
} from './pdfkit-mutation-fixture-data.js';

function pageGeometry(context, parameters, options) {
  const output = parameters.input.endsWith('output.pdf');
  const rotationRequest = context.observed?.request?.mutation?.rotation;
  const pageBox = context.observed?.request?.mutation?.pageBox;
  const requestedCrop = pageBox?.box === 'crop' ? pageBox.rect : null;
  const requestedBleed = pageBox?.box === 'bleed' ? pageBox.rect : null;
  const rotation = output && rotationRequest?.page === parameters.page
    ? rotationRequest.degrees : 0;
  const crop = output && requestedCrop
    ? options.outputCropBoxOverride ?? requestedCrop
    : { x: 0, y: 0, width: 612, height: 792 };
  const bleed = output && requestedBleed
    ? options.outputBleedBoxOverride ?? requestedBleed
    : { x: 0, y: 0, width: 612, height: 792 };
  return inspectedPageOutput(parameters.page, { rotation, crop, bleed });
}

async function recordSourceOperation(context, operation, parameters) {
  const sourceOperation = typeof parameters.input === 'string'
    && !parameters.input.endsWith('output.pdf');
  if (!sourceOperation) return false;
  assert.notEqual(
    parameters.input,
    context.sourcePath,
    `${operation} must not reopen the writable store source`,
  );
  if (operation === 'inspect') context.stagedSourcePath = parameters.input;
  assert.equal(parameters.input, context.stagedSourcePath, `${operation} must use one staged source`);
  assert.deepEqual(await readFile(parameters.input), sourceBytes);
  context.sourceCalls.push(operation);
  return true;
}

export function createPdfKitMutationFixturePoppler(context, options) {
  return {
    async execute(operation, parameters, executionOptions) {
      if (executionOptions?.signal?.aborted) throw new Error('cancelled');
      const sourceOperation = await recordSourceOperation(context, operation, parameters);
      if (operation === 'inspect') {
        if (options.swapSourceDuringNative && sourceOperation && !context.sourceSwapped) {
          await rename(context.sourcePath, context.sourceBackup);
          await writeFile(
            context.sourcePath,
            Buffer.from('%PDF-1.7\nhostile replacement\n%%EOF'),
            { mode: 0o600 },
          );
          context.sourceSwapped = true;
        }
        const pageCount = parameters.input.endsWith('output.pdf') ? options.outputPages : 2;
        return { stdout: `Pages: ${pageCount}\n${options.sourceSafety}\n` };
      }
      if (operation === 'verifySignatures') {
        return {
          stdout: typeof options.signatureOutput === 'function'
            ? options.signatureOutput(parameters.input)
            : options.signatureOutput
              ?? `File '${parameters.input}' does not contain any signatures\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (operation === 'inspectPage') {
        return { stdout: pageGeometry(context, parameters, options) };
      }
      if (operation === 'renderPagePng') {
        const output = parameters.input.endsWith('output.pdf');
        const renderBytes = output ? options.outputRenderBytes : options.sourceRenderBytes;
        await writeFile(
          `${parameters.outputPrefix}.png`,
          options.invalidPng ? Buffer.from('not png') : renderBytes,
          { mode: 0o600 },
        );
        if (options.unsafeValidationOutput) {
          await writeFile(
            join(dirname(parameters.outputPrefix), 'unexpected.txt'),
            'unexpected',
            { mode: 0o600 },
          );
        }
        if (options.swapSourceDuringNative && context.sourceSwapped && output
          && parameters.page === options.outputPages) {
          await rm(context.sourcePath);
          await rename(context.sourceBackup, context.sourcePath);
        }
        return { stdout: '' };
      }
      assert.fail(`Unexpected Poppler operation ${operation}`);
    },
  };
}

export const DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS = Object.freeze({
  helperPages: 2,
  outputPages: 2,
  unsafeOutput: false,
  invalidPng: false,
  unsafeValidationOutput: false,
  sourceSafety: 'Encrypted: no\nForm: none\nJavaScript: no',
  signatureOutput: null,
  localReceiptOverride: null,
  localRemovalReceiptOverride: null,
  outlineRemovalReceiptOverride: null,
  outlineRenameReceiptOverride: null,
  lineReceiptOverride: null,
  inkReceiptOverride: null,
  outlineReceiptOverride: null,
  mutationReceiptOverride: null,
  swapSourceDuringNative: false,
  outputCropBoxOverride: null,
  outputBleedBoxOverride: null,
  outputRenderBytes: png,
  sourceRenderBytes: png,
});
