import { constants as fsConstants } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspace, TIMEOUT_MS } from './aec-artifact-export.mjs';
import { fail } from './aec-artifact-validation.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OUTPUT_FILES = Object.freeze(['input.pdf', 'output.pdf', 'request.json']);

export async function assertPng(path) { const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { const metadata = await handle.stat(); const signature = Buffer.alloc(PNG_SIGNATURE.length); const { bytesRead } = await handle.read(signature, 0, signature.length, 0); if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < PNG_SIGNATURE.length || metadata.size > 16 * 1024 * 1024 || bytesRead !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) fail('AEC_NATIVE_OUTPUT_INVALID', 'Poppler did not produce a bounded AEC validation image.', 502); } finally { await handle.close(); } await chmod(path, 0o600); }
export async function renderAllPages({ poppler, workspace, outputPath, pageCount, signal, workspaceFiles = [] }) { const validationFiles = []; for (let page = 1; page <= pageCount; page += 1) { const prefix = join(workspace, `validation-${page}`); await poppler.execute('renderPagePng', { input: outputPath, outputPrefix: prefix, page, maxDimension: 256 }, { cwd: workspace, signal, timeoutMs: TIMEOUT_MS, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 }); await assertPng(`${prefix}.png`); validationFiles.push(`validation-${page}.png`); } await assertWorkspace(workspace, [...OUTPUT_FILES, ...workspaceFiles, ...validationFiles]); }
