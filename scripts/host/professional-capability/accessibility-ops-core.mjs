import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE } from '../pdf-accessibility-table-semantics-contract.mjs';
import {
  inspectPdfAccessibilityTableSemantics,
  writePdfAccessibilityTableSemantics,
} from '../pdf-accessibility-table-semantics-writer.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../pdf-tagged-remediation-contract.mjs';
import {
  inspectTaggedPdfRemediation,
  writeTaggedPdfRemediation,
} from '../pdf-tagged-remediation-writer.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
export { accessibilityFormSemantics } from './accessibility-ops-form.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function tableProductionInput(ctx) {
  if (ctx.sourcePdf === undefined && ctx.sourceBytes === undefined) {
    fail('ACCESSIBILITY_TABLE_SOURCE_REQUIRED', 'Accessible table repair requires explicit source PDF bytes.', 400);
  }
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf', { max: 32 * 1024 * 1024 });
  const sourceSha256 = sha256(source);
  if (ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied accessible-table source digest does not match the source PDF.', 409);
  }
  if (typeof ctx.documentId !== 'string' || ctx.documentId.length < 1) {
    fail('ACCESSIBILITY_TABLE_DOCUMENT_REQUIRED', 'Accessible table repair requires an explicit document identity.', 400);
  }
  if (!ctx.tableRequest || typeof ctx.tableRequest !== 'object' || Array.isArray(ctx.tableRequest)) {
    fail('ACCESSIBILITY_TABLE_REQUEST_REQUIRED', 'Accessible table repair requires the exact source-bound tableRequest.', 400);
  }
  if (ctx.tableRequest.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The accessible-table request is not bound to the supplied source PDF.', 409);
  }
  const service = ctx.accessibilityTableSemantics;
  if (!service || typeof service.repair !== 'function') {
    fail('ACCESSIBILITY_TABLE_SERVICE_UNAVAILABLE', 'The production accessible-table semantics service is unavailable.', 503);
  }
  const readArtifact = typeof ctx.readArtifact === 'function'
    ? ctx.readArtifact
    : typeof service.readArtifact === 'function' ? service.readArtifact.bind(service) : null;
  if (!readArtifact) {
    fail('ACCESSIBILITY_TABLE_ARTIFACT_READBACK_REQUIRED', 'Accessible table repair requires an explicit artifact reread authority.', 503);
  }
  return { source, sourceSha256, service, readArtifact, request: ctx.tableRequest };
}

function validateTableArtifact(receipt, { documentId, sourceSha256, artifactBytes }) {
  const artifact = receipt?.artifact;
  const outputSha256 = sha256(artifactBytes);
  const operation = artifact?.operation;
  if (receipt?.kind !== 'pdf-accessibility-table-semantics' || !receipt.proof
    || !Array.isArray(receipt.limitations) || receipt.limitations.length < 1
    || !artifact || !UUID.test(String(artifact.id ?? '')) || artifact.documentId !== documentId
    || artifact.mediaType !== 'application/pdf' || artifact.size !== artifactBytes.length
    || artifact.sha256 !== outputSha256 || outputSha256 === sourceSha256
    || operation?.type !== 'pdf-accessibility-table-semantics'
    || operation?.validation?.passed !== true || operation.validation.outputSha256 !== outputSha256
    || !Array.isArray(operation.inputs)
    || !operation.inputs.some((input) => input.documentId === documentId
      && input.sha256 === sourceSha256 && input.role === 'source')) {
    fail('ACCESSIBILITY_TABLE_RECEIPT_INVALID', 'The accessible-table receipt is not bound to the requested source and reread artifact.', 502);
  }
  return outputSha256;
}

async function productionTableSemantics(ctx) {
  const boundary = tableProductionInput(ctx);
  let receipt;
  try {
    receipt = await boundary.service.repair(ctx.documentId, boundary.request, { signal: ctx.signal });
  } catch (error) {
    if (error?.code) throw error;
    fail('ACCESSIBILITY_TABLE_SERVICE_FAILED', 'The production accessible-table semantics service failed.', 502);
  }
  let artifactBytes;
  try {
    artifactBytes = requireBytes(await boundary.readArtifact(receipt?.artifact), 'accessibleTableArtifact', { max: 64 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'INVALID_PROFESSIONAL_INPUT') {
      fail('ACCESSIBILITY_TABLE_RECEIPT_INVALID', 'The accessible-table artifact reread authority did not return bounded PDF bytes.', 502);
    }
    fail('ACCESSIBILITY_TABLE_ARTIFACT_READBACK_FAILED', 'The accessible-table artifact could not be reread.', 502);
  }
  const outputSha256 = validateTableArtifact(receipt, {
    documentId: ctx.documentId,
    sourceSha256: boundary.sourceSha256,
    artifactBytes,
  });
  let proof;
  try {
    proof = inspectPdfAccessibilityTableSemantics(boundary.source, artifactBytes, boundary.request);
  } catch {
    fail('ACCESSIBILITY_TABLE_OUTPUT_INVALID', 'Independent accessible-table inspection rejected the reread artifact.', 502);
  }
  if (!isDeepStrictEqual(proof, receipt.proof)) {
    fail('ACCESSIBILITY_TABLE_RECEIPT_INVALID', 'Independent accessible-table inspection disagreed with the production receipt.', 502);
  }
  return result('accessibility.table-semantics', {
    method: 'production-accessibility-table-semantics-service',
    serviceReceipt: receipt,
    artifact: receipt.artifact,
    limitations: receipt.limitations,
    table: Object.freeze({ ...boundary.request.table }),
    rowCount: proof.rowCount,
    columnCount: proof.columnCount,
    cellCount: proof.cellCount,
    pdf: artifactBytes,
    bytes: artifactBytes.length,
    outputSha256,
    sourceSha256: boundary.sourceSha256,
    applied: true,
    structureLinked: proof.structureLinked,
    proof,
    demoFixtureUsed: false,
    professionalProof: true,
    trustBoundary: Object.freeze({
      productionService: true,
      immutableSourceDigest: true,
      artifactReread: true,
      independentSemanticInspection: true,
    }),
  });
}

function explicitRepairInput(ctx, requestKey, createDemo) {
  const supplied = ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined;
  const request = ctx[requestKey];
  if (supplied) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      fail('ACCESSIBILITY_REPAIR_REQUEST_REQUIRED', `Supplied sourcePdf requires ${requestKey}.`, 422);
    }
    return Object.freeze({
      source: requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf'),
      request,
      demoFixtureUsed: false,
    });
  }
  if (request !== undefined || ctx.demoFixture !== true) {
    fail('ACCESSIBILITY_REPAIR_SOURCE_REQUIRED', `Accessibility repair requires sourcePdf and ${requestKey}.`, 422);
  }
  const demo = createDemo();
  return Object.freeze({ ...demo, demoFixtureUsed: true });
}

function tableMatrix(headers, rows) {
  const cols = headers.length;
  const cells = [];
  for (let c = 0; c < cols; c += 1) {
    cells.push({
      id: `h${c}`,
      role: 'TH',
      row: 0,
      column: c,
      text: String(headers[c]).slice(0, 80),
      scope: 'column',
    });
  }
  for (let r = 0; r < rows.length; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [rows[r]];
    for (let c = 0; c < cols; c += 1) {
      cells.push({
        id: `r${r}c${c}`,
        role: 'TD',
        row: r + 1,
        column: c,
        text: String(row[c] ?? '').slice(0, 80),
        headers: [`h${c}`],
      });
    }
  }
  return Object.freeze({
    headers: Object.freeze(headers.map(String).slice(0, 50)),
    rows: Object.freeze(rows.slice(0, 200).map((row) => Object.freeze(
      (Array.isArray(row) ? row : [row]).map((v) => String(v).slice(0, 80)),
    ))),
    scope: 'col',
    rowCount: rows.length + 1,
    columnCount: cols,
    cellCount: cells.length,
    cells: Object.freeze(cells.slice(0, 400)),
  });
}

function taggedTableSemanticsSource(table) {
  const rowObjectStart = 9;
  const cellObjectStart = rowObjectStart + table.rowCount;
  const parentTreeObject = cellObjectStart + table.cells.length;
  const rowReferences = Array.from({ length: table.rowCount }, (_, index) => rowObjectStart + index);
  const cellReferences = table.cells.map((_, index) => cellObjectStart + index);
  const stream = table.cells.map((_, index) => `/P <</MCID ${index}>> BDC\nq Q\nEMC\n`).join('');
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo 7 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /StructParents 0 >>'],
    [4, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`],
    [5, '<< /Type /Pages >>'],
    [6, `<< /Type /StructTreeRoot /K [8 0 R] /ParentTree ${parentTreeObject} 0 R >>`],
    [7, '<< /Marked true >>'],
    [8, `<< /Type /StructElem /S /Table /P 6 0 R /K [${rowReferences.map((object) => `${object} 0 R`).join(' ')}] >>`],
  ]);
  for (const [row, object] of rowReferences.entries()) {
    const cells = table.cells
      .map((cell, index) => ({ cell, reference: cellReferences[index] }))
      .filter(({ cell }) => cell.row === row);
    bodies.set(object, `<< /Type /StructElem /S /TR /P 8 0 R /K [${cells.map(({ reference }) => `${reference} 0 R`).join(' ')}] >>`);
  }
  for (const [index, cell] of table.cells.entries()) {
    const rowReference = rowReferences[cell.row];
    bodies.set(cellReferences[index], `<< /Type /StructElem /S /${cell.role} /P ${rowReference} 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID ${index} >>] >>`);
  }
  bodies.set(parentTreeObject, `<< /Nums [0 [${cellReferences.map((object) => `${object} 0 R`).join(' ')}]] >>`);
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (let object = 1; object <= parentTreeObject; object += 1) {
    offsets.set(object, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${object} 0 obj\n${bodies.get(object)}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${parentTreeObject + 1}\n0000000000 65535 f \n`);
  for (let object = 1; object <= parentTreeObject; object += 1) {
    chunks.push(`${String(offsets.get(object)).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${parentTreeObject + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const source = Buffer.from(chunks.join(''), 'latin1');
  const request = {
    profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE,
    sourceSha256: sha256(source),
    table: {
      tableRef: { object: 8, generation: 0 },
      cells: table.cells.map((cell, index) => ({
        id: cell.id,
        structRef: { object: cellReferences[index], generation: 0 },
        role: cell.role,
        row: cell.row,
        column: cell.column,
        page: 1,
        contentRef: { object: 4, generation: 0 },
        mcid: index,
        scope: cell.role === 'TH' ? 'column' : null,
        headers: cell.headers ?? [],
        rowSpan: 1,
        colSpan: 1,
      })),
    },
  };
  return Object.freeze({ source, request });
}


export { productionTableSemantics, explicitRepairInput, tableMatrix, taggedTableSemanticsSource };
