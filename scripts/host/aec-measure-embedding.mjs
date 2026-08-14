import { createHash } from 'node:crypto';
import { chmod, open, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readRegularOutput } from './bounded-output-io.mjs';
import { fail } from './aec-artifact-validation.mjs';
import {
  inspectIncrementalAecMeasureDictionary,
  writeIncrementalAecMeasureDictionary,
} from './pdf-aec-measure-writer.mjs';

const MINIMUM_PDF_BYTES = 64;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function overlap(left, right) {
  return left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}

async function readOutput(path, maximumBytes, label) {
  try {
    return await readRegularOutput(path, {
      minimumBytes: MINIMUM_PDF_BYTES,
      maximumBytes,
      label,
    });
  } catch (error) {
    fail(
      'AEC_MEASURE_DICTIONARY_OUTPUT_INVALID',
      'The AEC measurement PDF could not be read as a stable private file.',
      502,
      error,
    );
  }
}

async function stagePrivateOutput(path, bytes) {
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(path, 0o400);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(path).catch(() => {});
    fail(
      'AEC_MEASURE_DICTIONARY_OUTPUT_INVALID',
      'The calibrated AEC PDF could not be staged privately.',
      502,
      error,
    );
  }
}

function writeCandidate(sourceBytes, input, maximumBytes) {
  try {
    const written = writeIncrementalAecMeasureDictionary(sourceBytes, input);
    if (!Buffer.isBuffer(written?.bytes) || !written.proof
      || overlap(sourceBytes, written.bytes)
      || written.bytes.length > maximumBytes
      || !written.bytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
      fail(
        'AEC_MEASURE_DICTIONARY_OUTPUT_INVALID',
        'The calibrated AEC writer returned an invalid bounded PDF.',
        502,
      );
    }
    return written;
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF') {
      fail(
        'AEC_MEASURE_DICTIONARY_UNSUPPORTED',
        'The PDFKit artifact is outside the bounded calibrated AEC PDF subset.',
        422,
        error,
      );
    }
    throw error;
  }
}

function inspectCandidate(sourceBytes, outputBytes, input, expectedProof) {
  try {
    const proof = inspectIncrementalAecMeasureDictionary(sourceBytes, outputBytes, input);
    if (!isDeepStrictEqual(proof, expectedProof)) {
      fail(
        'AEC_MEASURE_DICTIONARY_OUTPUT_INVALID',
        'Independent AEC measure-dictionary reinspection disagreed with the writer proof.',
        502,
      );
    }
    return proof;
  } catch (error) {
    if (error?.code === 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT') {
      fail(
        'AEC_MEASURE_DICTIONARY_OUTPUT_INVALID',
        'Independent AEC measure-dictionary reinspection rejected the staged PDF.',
        502,
        error,
      );
    }
    throw error;
  }
}

export async function createAecFinalOutput({
  nativeOutputPath,
  finalOutputPath,
  nativeOutputSha256,
  measurement,
  calibration,
  maximumSourceBytes,
  maximumOutputBytes,
  signal,
}) {
  if (!Number.isSafeInteger(maximumSourceBytes) || maximumSourceBytes < MINIMUM_PDF_BYTES
    || !Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < maximumSourceBytes) {
    throw new TypeError('AEC final-output byte limits are invalid.');
  }
  let sourceBytes = null;
  let writtenBytes = null;
  let finalBytes = null;
  let completed = false;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('AEC finalization was cancelled.');
    sourceBytes = await readOutput(
      nativeOutputPath,
      maximumSourceBytes,
      'Native AEC PDF output',
    );
    if (sha256(sourceBytes) !== nativeOutputSha256) {
      fail('AEC_NATIVE_OUTPUT_INVALID', 'Native AEC output changed before calibration embedding.', 502);
    }
    let proof = null;
    if (measurement.kind === 'count') {
      writtenBytes = Buffer.from(sourceBytes);
    } else {
      if (!calibration) {
        fail('AEC_CALIBRATION_STALE', 'Calibrated AEC output requires a source-bound scale.', 409);
      }
      const input = { measurement, calibration };
      const written = writeCandidate(sourceBytes, input, maximumOutputBytes);
      writtenBytes = written.bytes;
      proof = written.proof;
    }
    if (signal?.aborted) throw signal.reason ?? new Error('AEC finalization was cancelled.');
    await stagePrivateOutput(finalOutputPath, writtenBytes);
    writtenBytes.fill(0);
    writtenBytes = null;
    finalBytes = await readOutput(finalOutputPath, maximumOutputBytes, 'Final AEC PDF');
    if (measurement.kind === 'count') {
      if (!finalBytes.equals(sourceBytes)) {
        fail('AEC_MEASURE_DICTIONARY_OUTPUT_INVALID', 'Final count artifact differs from its validated native output.', 502);
      }
    } else {
      proof = inspectCandidate(
        sourceBytes,
        finalBytes,
        { measurement, calibration },
        proof,
      );
    }
    if (signal?.aborted) throw signal.reason ?? new Error('AEC finalization was cancelled.');
    completed = true;
    return Object.freeze({ nativeOutputSha256, outputSha256: sha256(finalBytes), proof });
  } finally {
    if (!completed) await unlink(finalOutputPath).catch(() => {});
    sourceBytes?.fill(0);
    writtenBytes?.fill(0);
    finalBytes?.fill(0);
  }
}
