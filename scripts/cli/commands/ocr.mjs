import { ocrLayoutHtml } from '../../../src/core/ocr-layout-export.js';

const MAX_ALTO_BYTES = 2 * 1024 * 1024;
function strictAltoBytes(record, fail) { const alto = record?.alto; const pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u; if (alto?.mediaType !== 'application/alto+xml' || alto.encoding !== 'base64' || typeof alto.data !== 'string' || !pattern.test(alto.data) || !Number.isSafeInteger(alto.byteLength) || alto.byteLength < 1 || alto.byteLength > MAX_ALTO_BYTES) fail('CLI_INVALID_ENGINE_OUTPUT', 'OCR layout did not return bounded ALTO XML evidence.'); const bytes = Buffer.from(alto.data, 'base64'); if (bytes.length !== alto.byteLength) fail('CLI_INVALID_ENGINE_OUTPUT', 'OCR ALTO evidence length does not match its record.'); return bytes; }

export async function runOcrCommand(application, command, stdout, signal, runtime) {
  const { uploadPdf, copyExclusive, emit, writeExclusive, cancelled, fail } = runtime;
  const document = await uploadPdf(application, command.input, signal);
  if (command.command === 'ocr') { const { artifact } = await application.service.ocrDocument(document.id, { ...command, signal }); cancelled(signal); await copyExclusive(application.store.getArtifact(artifact.id).filePath, command.output); await emit(stdout, { kind: 'searchable-ocr', output: command.output.split(/[\\/]/u).pop(), sha256: artifact.sha256, localOnly: true }); return; }
  const result = await application.service.analyzeOcrLayout(document.id, { language: command.language, pages: [command.page], zones: command.region ? [{ id: 'cli-region', page: command.page, ...command.region }] : [], cleanupPreset: command.cleanupPreset, segmentation: command.segmentation, detectTables: command.detectTables, signal });
  const value = command.format === 'html' ? ocrLayoutHtml(result) : command.format === 'alto' ? strictAltoBytes(result.records?.[0], fail) : result;
  if (command.output) await writeExclusive(command.output, value); else if (Buffer.isBuffer(value)) fail('CLI_INVALID_OPTION', 'ALTO output requires --output to avoid writing XML bytes to a terminal.'); else await emit(stdout, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
