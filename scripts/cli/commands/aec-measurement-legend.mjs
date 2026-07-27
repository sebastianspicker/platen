function csvCell(value) { const text = String(value ?? ''); return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csv(result) {
  const rows = [['toolId', 'styleId', 'kind', 'dimension', 'displayUnit', 'count', 'totalSiValue', 'measurementId', 'page', 'sheetId', 'labelDigest', 'siValue', 'siUnit']];
  for (const group of result.groups) for (const measurement of group.measurements) rows.push([group.toolId, group.styleId, group.kind, group.dimension, group.displayUnit, group.count, group.totalSiValue, measurement.id, measurement.page, measurement.sheetId, measurement.labelDigest, measurement.siValue, measurement.siUnit]);
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
export async function runAecMeasurementLegendCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  const workspace = application.workspaceState.snapshot(document.id);
  const measurements = workspace.namespaces.measurements.filter((record) => record?.schemaVersion === 2 && record.type === 'measurement');
  if (!measurements.length) { const error = new Error('The current AEC workspace has no source-bound measurements.'); error.code = 'AEC_MEASUREMENT_NOT_FOUND'; throw error; }
  const result = await application.aecMeasurementLegend.generate({ sourceSha256: document.sha256, expectedRevision: workspace.revision, records: measurements.map((record) => ({ sheetId: record.sheetId ?? `page-${record.source.page}`, page: record.source.page, revision: workspace.revision, toolId: record.toolId ?? `aec-${record.kind}`, styleId: record.styleId ?? 'default', measurement: { kind: 'source-bound-aec-measurement', schemaVersion: 1, sourceDigest: document.sha256, workspaceRevision: workspace.revision, measurement: record } })) }, { signal });
  runtime.cancelled(signal);
  const output = command.format === 'csv' ? csv(result) : `${JSON.stringify(result, null, 2)}\n`;
  await runtime.writeExclusive(command.output, output, signal);
  await runtime.emit(stdout, { kind: 'aec-measurement-legend-export', format: command.format, output: command.output, outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'), recordCount: result.recordCount, sourceDigest: result.sourceDigest, sheetRevision: result.sheetRevision, localOnly: true });
}
import { createHash } from 'node:crypto';
