import { before, test } from 'node:test';
import * as support from './host-pdfkit-test-support.js';

const {
  assert, chmod, mkdtemp, readFile, rm, writeFile, tmpdir, join, spawnSync,
  makeTargetedSanitizationPdf, packagePath, runInspection, runTargetedMutation, deriveTargetedSanitizationSource,
  sourceSha256, targetedMutationRequest, canRunIntegration,
} = support;

function reopenSquare(path) {
  const run = spawnSync('xcrun', ['swift', '-', path], {
    input: [
      'import Foundation', 'import PDFKit', 'import CoreGraphics',
      'let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!',
      'let page = document.page(at: 1)!; let annotation = page.annotations[0]',
      'let rawPage = document.documentRef!.page(at: 2)!.dictionary!',
      'var annotations: CGPDFArrayRef?; CGPDFDictionaryGetArray(rawPage, "Annots", &annotations)',
      'var raw: CGPDFDictionaryRef?; CGPDFArrayGetDictionary(annotations!, 0, &raw)',
      'var color: CGPDFArrayRef?; CGPDFDictionaryGetArray(raw!, "C", &color)',
      'let rgb = (0..<3).map { index -> Double in var value = CGPDFReal(0); CGPDFArrayGetNumber(color!, index, &value); return Double(value) }',
      'var red = CGFloat(0); var green = CGFloat(0); var blue = CGFloat(0); var alpha = CGFloat(0)',
      'annotation.color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)',
      'let value: [String: Any] = ["contents": annotation.contents ?? "", "x": annotation.bounds.minX, "y": annotation.bounds.minY, "width": annotation.bounds.width, "height": annotation.bounds.height, "pdfkit": [Double(red), Double(green), Double(blue)], "raw": rgb]',
      'let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])',
      'print(String(data: data, encoding: .utf8)!, terminator: "")',
    ].join('\n'), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function appearanceShapeFaultPdf() {
  const content = 'BT\n/F1 18 Tf\n72 720 Td\n(appearance fault fixture) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Annot /Subtype /Square /Rect [72 550 300 620] /Contents (target contents) /AP << /N /On >> /P 3 0 R >>',
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary')); body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'binary'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'binary');
}

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--disable-sandbox', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

test('installed helper persists only source-bound Square bounds and canonical border color', {
  skip: !canRunIntegration(),
}, async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-annotation-properties-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const source = makeTargetedSanitizationPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const authoredSource = await deriveTargetedSanitizationSource(workspace);
  const beforeInspection = await runInspection(workspace);
  const target = beforeInspection.response.result.pages[1].annotations.find(({ subtype }) => subtype === 'square');
  const request = targetedMutationRequest(sourceSha256(authoredSource), {
    formFill: null, annotationUpdate: null, annotationRemove: null,
    annotationProperties: {
      page: 2, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint, subtype: 'square',
      rect: { x: 84, y: 540, width: 196, height: 52 }, strokeColor: '#12abef',
    },
  });
  const { response } = await runTargetedMutation(workspace, request);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(response.result, {
    schema: 'pdfkit-targeted-mutation-receipt-v1', version: 1, operation: 'targetedMutate',
    category: 'annotation-properties', sourceSha256: sourceSha256(authoredSource),
    outputSha256: sourceSha256(await readFile(join(workspace, 'output.pdf'))), pageCount: 2,
    appliedEdits: 1, reopenVerified: true, annotationPropertiesGeometryVerified: true,
    annotationPropertiesColorVerified: true, rawAnnotationColorVerified: true,
    nonTargetAnnotationsVerified: true, targetAnnotationPreservationVerified: true,
  });
  const observed = reopenSquare(join(workspace, 'output.pdf'));
  assert.deepEqual({ ...observed, pdfkit: undefined, raw: undefined }, {
    contents: 'private non-target-page contents', x: 84, y: 540, width: 196, height: 52,
    pdfkit: undefined, raw: undefined,
  });
  for (const components of [observed.pdfkit, observed.raw]) {
    components.forEach((value, index) => assert.ok(Math.abs(value - [18, 171, 239][index] / 255) <= 0.001));
  }
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), authoredSource);
});

test('installed helper refuses an output whose target appearance descriptor changes shape', {
  skip: !canRunIntegration(),
}, async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-annotation-properties-fault-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const source = appearanceShapeFaultPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 }); await chmod(workspace, 0o700);
  const { response: inspection } = await runInspection(workspace);
  const target = inspection.result.pages[0].annotations.find(({ subtype }) => subtype === 'square');
  const { response } = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
    formFill: null, annotationUpdate: null, annotationRemove: null,
    annotationProperties: {
      page: 1, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint, subtype: 'square',
      rect: { x: 84, y: 540, width: 196, height: 52 }, strokeColor: '#12abef',
    },
  }));
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'OUTPUT_INVALID' } });
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
});
