import { createHash } from 'node:crypto';
import {
  inspectPdfAccessibilityTableSemantics, writePdfAccessibilityTableSemantics,
} from '../pdf-accessibility-table-semantics-writer.mjs';
import { result, fail, sha256 } from './support.mjs';
import { productionTableSemantics, explicitRepairInput, tableMatrix, taggedTableSemanticsSource } from './accessibility-ops-core.mjs';

export async function accessibilityTableSemantics(ctx = {}) {
  if (ctx.demoFixture !== true || ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined
    || ctx.tableRequest !== undefined || ctx.accessibilityTableSemantics !== undefined) {
    return productionTableSemantics(ctx);
  }
  const headers = Array.isArray(ctx.headers) ? ctx.headers.map(String).slice(0, 50) : ['Name', 'Value'];
  const rows = Array.isArray(ctx.rows) ? ctx.rows.slice(0, 200) : [['A', '1'], ['B', '2']];
  if (headers.length < 1) fail('INVALID_TABLE', 'headers required', 400);
  const table = tableMatrix(headers, rows);
  const tableSha256 = createHash('sha256').update(JSON.stringify({
    headers: table.headers,
    rows: table.rows,
    scope: table.scope,
  })).digest('hex');
  const repair = explicitRepairInput(ctx, 'tableRequest', () => taggedTableSemanticsSource(table));
  const { source, request } = repair;
  const written = writePdfAccessibilityTableSemantics(source, request);
  const proof = inspectPdfAccessibilityTableSemantics(source, written.bytes, request);
  const pdf = written.bytes;
  return result('accessibility.table-semantics', {
    method: 'local-accessibility-table-semantics-repair',
    table,
    tableSha256,
    rowCount: table.rowCount,
    columnCount: table.columnCount,
    cellCount: table.cellCount,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
    applied: true,
    structureLinked: proof.structureLinked,
    proof,
    sourceSha256: sha256(source),
    demoFixtureUsed: repair.demoFixtureUsed,
    sourceByteLength: source.length,
    repairRequest: request,
    professionalProof: false,
  });
}

