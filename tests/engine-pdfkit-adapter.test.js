import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFKitAdapter } from '../scripts/host/adapters/pdfkit.mjs';
import { helperDigest, inkAnnotationSuccess, lineAnnotationSuccess, localGoToRemovalSuccess, localGoToSuccess, metadataSanitizationSuccess, mutationSuccess, outlineBookmarkRemovalSuccess, outlineBookmarkRenameSuccess, outlineBookmarkSuccess, protectionRemovalSuccess, protectionSuccess, success } from './support/engine-pdfkit-fixtures.js';

test('PDFKit adapter uses a trusted fixed executable and private request workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  await chmod(request, 0o600);
  const calls = [];
  const verifications = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect',
    expectedSha256: helperDigest,
    verifyExecutable: async (value) => { verifications.push(value); },
    runner: async (invocation) => { calls.push(invocation); return { stdout: success, stderr: '', exitCode: 0 }; },
  });
  await adapter.inspect({ workspacePath: workspace, requestPath: request }, {
    executable: '/untrusted/override', args: ['--evil'], environment: { HOME: workspace }, shell: true,
    detached: true, stdio: 'inherit', timeoutMs: 1_000,
  });
  const [realWorkspace, realRequest] = await Promise.all([realpath(workspace), realpath(request)]);
  assert.deepEqual(calls, [{
    executable: '/trusted/pdfkit-inspect', args: ['--request', realRequest], cwd: realWorkspace,
    maxStdoutBytes: 524_288, maxStderrBytes: 4_096, timeoutMs: 1_000,
  }]);
  assert.deepEqual(verifications, [{ executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest }]);
});

test('PDFKit mutation uses the same pinned executable and private request boundary', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => { calls.push(invocation); return { stdout: mutationSuccess, stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.mutate({ workspacePath: workspace, requestPath: request }, { timeoutMs: 1_000 });
  assert.equal(result.appliedEdits, 4);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit local GoTo uses the pinned helper and its strict compact parser', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-goto-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => { calls.push(invocation); return { stdout: localGoToSuccess, stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.addLocalGoToLink({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'local-goto-link');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit local GoTo removal uses the pinned helper and strict delta parser', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-goto-remove-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => {
      calls.push(invocation);
      return { stdout: localGoToRemovalSuccess, stderr: '', exitCode: 0 };
    },
  });
  const result = await adapter.removeLocalGoToLink({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'local-goto-link-removal');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit outline bookmark uses the pinned helper and strict preservation receipt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-outline-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => {
      calls.push(invocation);
      return { stdout: outlineBookmarkSuccess, stderr: '', exitCode: 0 };
    },
  });
  const result = await adapter.appendOutlineBookmark({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'outline-bookmark');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit outline bookmark removal uses the pinned helper and strict delta receipt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-outline-remove-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => {
      calls.push(invocation);
      return { stdout: outlineBookmarkRemovalSuccess, stderr: '', exitCode: 0 };
    },
  });
  const result = await adapter.removeOutlineBookmark({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'outline-bookmark-removal');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit outline bookmark rename uses the pinned helper and strict delta receipt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-outline-rename-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => {
      calls.push(invocation);
      return { stdout: outlineBookmarkRenameSuccess, stderr: '', exitCode: 0 };
    },
  });
  const result = await adapter.renameOutlineBookmark({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'outline-bookmark-rename');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit line annotation uses the pinned helper and its strict compact parser', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-line-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => { calls.push(invocation); return { stdout: lineAnnotationSuccess, stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.addLineAnnotation({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'line-annotation');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit ink annotation uses the pinned helper and its strict compact parser', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-ink-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => { calls.push(invocation); return { stdout: inkAnnotationSuccess, stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.addInkAnnotation({ workspacePath: workspace, requestPath: request });
  assert.equal(result.category, 'ink-annotation');
  assert.deepEqual(calls[0].args, ['--request', await realpath(request)]);
});

test('PDFKit protection uses bounded stdin with no secret in argv or errors', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-protect-'));
  await chmod(workspace, 0o700);
  const requestBuffer = Buffer.from('{"ownerPassword":"private-owner","userPassword":"private-user"}');
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => { calls.push(invocation); return { stdout: protectionSuccess, stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.protect({ workspacePath: workspace, requestBuffer }, { timeoutMs: 1_000 });
  assert.equal(result.profile, 'accessibility-only');
  assert.deepEqual(calls[0].args, ['--protect-stdin']);
  assert.equal(calls[0].cwd, await realpath(workspace));
  assert.equal(calls[0].stdin, requestBuffer);
  assert.doesNotMatch(JSON.stringify({ ...calls[0], stdin: undefined }), /private-owner|private-user/);

  const failing = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async () => { throw new Error('private-owner'); },
  });
  await assert.rejects(
    failing.protect({ workspacePath: workspace, requestBuffer }),
    (error) => error.code === 'PDFKIT_HELPER_FAILED' && !JSON.stringify(error).includes('private-owner'),
  );
  await assert.rejects(adapter.protect({ workspacePath: workspace, requestBuffer: Buffer.alloc(8_193) }), /bounded/);
});

test('PDFKit protection removal uses the distinct bounded stdin operation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-unprotect-'));
  await chmod(workspace, 0o700);
  const requestBuffer = Buffer.from('{"ownerPassword":"private-owner"}');
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => { calls.push(invocation); return { stdout: protectionRemovalSuccess, stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.removeProtection({ workspacePath: workspace, requestBuffer });
  assert.equal(result.ownerAuthorizationVerified, true);
  assert.deepEqual(calls[0].args, ['--remove-protection-stdin']);
  assert.equal(calls[0].stdin, requestBuffer);
  assert.doesNotMatch(JSON.stringify({ ...calls[0], stdin: undefined }), /private-owner/);
});

test('PDFKit metadata sanitization uses its distinct bounded stdin operation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-sanitize-metadata-'));
  await chmod(workspace, 0o700);
  const requestBuffer = Buffer.from('{"operation":"sanitizeMetadata"}');
  const calls = [];
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => {},
    runner: async (invocation) => {
      calls.push(invocation);
      return { stdout: metadataSanitizationSuccess, stderr: '', exitCode: 0 };
    },
  });
  const result = await adapter.sanitizeMetadata({ workspacePath: workspace, requestBuffer });
  assert.equal(result.metadataAbsent, true);
  assert.deepEqual(calls[0].args, ['--sanitize-metadata-stdin']);
  assert.equal(calls[0].stdin, requestBuffer);
});

test('PDFKit adapter rejects non-private, escaped, or malformed path inputs before execution', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  await chmod(request, 0o600);
  const adapter = new PDFKitAdapter({ executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest, verifyExecutable: async () => {}, runner: async () => assert.fail('must not run') });
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: join(workspace, '..', 'elsewhere.json') }), /private workspace files/);
  await chmod(request, 0o644);
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: request }), /private request\.json/);
  assert.throws(() => new PDFKitAdapter({ executable: 'relative', expectedSha256: helperDigest, verifyExecutable: async () => {} }), /absolute path/);
  assert.throws(() => new PDFKitAdapter({ executable: '/trusted/pdfkit-inspect', expectedSha256: 'short', verifyExecutable: async () => {} }), /SHA-256/);
});

test('PDFKit adapter rejects request symlinks, hard links, and oversized requests before execution', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-'));
  const request = join(workspace, 'request.json');
  const source = join(workspace, 'source.json');
  await writeFile(source, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  await chmod(source, 0o600);
  const adapter = new PDFKitAdapter({ executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest, verifyExecutable: async () => {}, runner: async () => assert.fail('must not run') });
  await symlink(source, request);
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: request }), /private request\.json/);
  await unlink(request);
  await writeFile(request, '{}', { mode: 0o600 });
  await link(request, join(workspace, 'hardlink.json'));
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: request }), /private request\.json/);
  await unlink(join(workspace, 'hardlink.json'));
  await writeFile(request, 'x'.repeat(8_193), { mode: 0o600 });
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: request }), /private request\.json/);
});

test('PDFKit adapter sanitizes helper process failures', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  await chmod(request, 0o600);
  const adapter = new PDFKitAdapter({ executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest, verifyExecutable: async () => {}, runner: async () => {
    throw Object.assign(new Error(`native error at ${workspace}`), { args: [request] });
  } });
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: request }), (error) => (
    error.code === 'PDFKIT_HELPER_FAILED' && !error.message.includes(workspace)
  ));
});

test('PDFKit adapter fails closed when the staged helper digest cannot be verified', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-adapter-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const adapter = new PDFKitAdapter({
    executable: '/trusted/pdfkit-inspect', expectedSha256: helperDigest,
    verifyExecutable: async () => { throw new Error(`digest mismatch at ${workspace}`); },
    runner: async () => assert.fail('untrusted helper must not run'),
  });
  await assert.rejects(adapter.inspect({ workspacePath: workspace, requestPath: request }), (error) => (
    error.code === 'PDFKIT_HELPER_UNTRUSTED' && !error.message.includes(workspace)
  ));
});
