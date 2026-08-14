import { basename } from 'node:path';

async function writeToStream(stream, text) {
  await new Promise((resolveWrite, rejectWrite) => {
    stream.write(text, (error) => (error ? rejectWrite(error) : resolveWrite()));
  });
}

export async function emit(stream, value) {
  const text = typeof value === 'string'
    ? value
    : `${JSON.stringify(value, null, 2)}\n`;
  await writeToStream(stream, text);
}

export async function emitCompact(stream, value) {
  await writeToStream(stream, `${JSON.stringify(value)}\n`);
}

export async function waitFor(milliseconds, signal, cancelled) {
  cancelled(signal);
  await new Promise((resolveWait, rejectWait) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(Object.assign(
        new Error('The local CLI operation was cancelled.'),
        { code: 'JOB_CANCELLED' },
      ));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function outputValue(command, stream, value, signal, runtime) {
  const bytes = typeof value === 'string'
    ? value
    : `${JSON.stringify(value, null, 2)}\n`;
  runtime.cancelled(signal);
  if (command.output) {
    await runtime.writeExclusive(command.output, bytes, signal);
    return;
  }
  await emit(stream, bytes);
  runtime.cancelled(signal);
}

export function safeBatchStem(name, index) {
  const raw = basename(name)
    .replace(/\.[^.]*$/u, '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
    .slice(0, 80);
  return `${String(index + 1).padStart(3, '0')}-${raw || 'document'}`;
}
