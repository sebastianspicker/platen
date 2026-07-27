import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { HostError } from './host-error.mjs';

export async function digestFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function throwIfPromotionAborted(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Artifact promotion was cancelled.', 499);
}

export async function copyVerifiedFileHandle(source, target, expectedSize, signal) {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, expectedSize)); let position = 0;
  while (position < expectedSize) {
    throwIfPromotionAborted(signal);
    const requested = Math.min(buffer.length, expectedSize - position); const { bytesRead } = await source.read(buffer, 0, requested, position);
    if (bytesRead !== requested) throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output changed while it was being retained.', 502);
    hash.update(buffer.subarray(0, bytesRead)); let written = 0;
    while (written < bytesRead) { const result = await target.write(buffer, written, bytesRead - written, position + written); if (!result.bytesWritten) throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output could not be retained completely.', 502); written += result.bytesWritten; }
    position += bytesRead;
  }
  throwIfPromotionAborted(signal); return hash.digest('hex');
}
