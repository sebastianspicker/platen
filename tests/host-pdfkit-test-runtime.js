import { assert, chmod, mkdtemp, readFile, tmpdir, join, spawnSync, unlink, writeFile, makeLocatorPdf, emptyMutation, mutationRequest, productPath, limits, sourceSha256 } from './host-pdfkit-test-core.js';
async function runInspection(workspace, inputFilename = 'input.pdf') {
  const request = join(workspace, 'request.json');
  await writeFile(request, JSON.stringify({
    version: 1, operation: 'inspect', inputFilename, limits,
  }), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function runMutation(workspace, mutation) {
  const request = join(workspace, 'request.json');
  const input = await readFile(join(workspace, 'input.pdf'));
  await writeFile(request, JSON.stringify(mutationRequest(mutation, sourceSha256(input))), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

async function runTargetedMutation(workspace, requestBody) {
  const request = join(workspace, 'request.json');
  await writeFile(request, JSON.stringify(requestBody), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function deriveTargetedSanitizationSource(workspace) {
  let source;
  for (const annotation of [
    { page: 1, subtype: 'freeText', contents: 'private targeted removal contents', rect: { x: 72, y: 550, width: 220, height: 40 } },
    { page: 1, subtype: 'circle', contents: 'private retained target-page contents', rect: { x: 320, y: 550, width: 180, height: 70 } },
    { page: 2, subtype: 'square', contents: 'private non-target-page contents', rect: { x: 72, y: 550, width: 220, height: 70 } },
  ]) {
    const result = await runMutation(workspace, { ...emptyMutation(), annotations: [annotation] });
    assert.equal(result.ok, true);
    source = await readFile(join(workspace, 'output.pdf'));
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await unlink(join(workspace, 'output.pdf'));
    await unlink(join(workspace, 'request.json'));
  }
  return source;
}

async function runLocalGoTo(workspace, requestBody) {
  const request = join(workspace, 'request.json');
  await writeFile(request, JSON.stringify(requestBody), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function runLineAnnotation(workspace, requestBody) {
  const request = join(workspace, 'request.json');
  await writeFile(request, JSON.stringify(requestBody), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function runInkAnnotation(workspace, requestBody) {
  const request = join(workspace, 'request.json');
  await writeFile(request, JSON.stringify(requestBody), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

function runProtection(workspace, requestBody) {
  const run = spawnSync(productPath, ['--protect-stdin'], {
    cwd: workspace, input: JSON.stringify(requestBody), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

function runProtectionRemoval(workspace, requestBody) {
  const run = spawnSync(productPath, ['--remove-protection-stdin'], {
    cwd: workspace, input: JSON.stringify(requestBody), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

function runMetadataSanitization(workspace, requestBody) {
  const run = spawnSync(productPath, ['--sanitize-metadata-stdin'], { cwd: workspace, input: JSON.stringify(requestBody), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function directlyEncryptFixture(source) {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-remove-protection-unsafe-'));
  const plain = join(workspace, 'plain.pdf');
  const encrypted = join(workspace, 'input.pdf');
  await writeFile(plain, source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const run = spawnSync('xcrun', ['swift', '-', plain, encrypted], {
    input: [
      'import Foundation', 'import PDFKit',
      'let source = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!',
      'let options: [PDFDocumentWriteOption: Any] = [.ownerPasswordOption: "Owner-Pass-123", .userPasswordOption: "User-Pass-4567", .accessPermissionsOption: NSNumber(value: 0)]',
      'let data = source.dataRepresentation(options: options)!',
      'try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))',
    ].join('\n'), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  await chmod(encrypted, 0o600);
  await unlink(plain);
  return { workspace, encrypted: await readFile(encrypted) };
}

function nativeContentHashes(path, password = '') {
  const run = spawnSync('xcrun', ['swift', '-', path, password], {
    input: [
      'import Foundation', 'import PDFKit', 'import CoreGraphics', 'import CryptoKit',
      'let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!',
      'if document.isLocked { guard document.unlock(withPassword: CommandLine.arguments[2]) else { fatalError("unlock") } }',
      'func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }',
      'func render(_ index: Int) -> String {',
      '  let page = document.documentRef!.page(at: index + 1)!',
      '  let context = CGContext(data: nil, width: 256, height: 256, bitsPerComponent: 8, bytesPerRow: 1024, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!',
      '  let target = CGRect(x: 0, y: 0, width: 256, height: 256)',
      '  context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(target)',
      '  context.concatenate(page.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true)); context.drawPDFPage(page)',
      '  return digest(Data(bytes: context.data!, count: 256 * 256 * 4))',
      '}',
      'let text = (0..<document.pageCount).map { digest(Data(document.page(at: $0)!.string!.utf8)) }',
      'let renders = (0..<document.pageCount).map(render)',
      'let data = try! JSONSerialization.data(withJSONObject: ["text": text, "renders": renders], options: [.sortedKeys])',
      'print(String(data: data, encoding: .utf8)!, terminator: "")',
    ].join('\n'), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

async function locatorWorkspace(options) {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-targeted-'));
  const source = makeLocatorPdf(options);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const inspection = await runInspection(workspace);
  assert.equal(inspection.response.ok, true);
  return { workspace, source, inspection: inspection.response.result };
}

function canRunIntegration() {
  if (process.platform !== 'darwin') return false;
  return spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8' }).status === 0;
}

export { runInspection, runMutation, runTargetedMutation, deriveTargetedSanitizationSource, runLocalGoTo, runLineAnnotation, runInkAnnotation, runProtection, runProtectionRemoval, runMetadataSanitization, directlyEncryptFixture, nativeContentHashes, locatorWorkspace, canRunIntegration };
