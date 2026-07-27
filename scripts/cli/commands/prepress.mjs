import { serializePreflightReportXml } from '../../host/preflight-rules.mjs';

export async function runPrepressCommand(application, command, document, stdout, signal, runtime) {
  const { copyExclusive, emit, outputValue, cancelled } = runtime;
  if (command.operation === 'icc-convert' || command.operation === 'imposition') { const result = command.operation === 'icc-convert' ? await application.prepress.convertToCmyk(document.id, { signal }) : await application.prepress.createImposition(document.id, { layout: command.layout, marks: false, signal }); cancelled(signal); await copyExclusive(application.store.getArtifact(result.artifact.id).filePath, command.output); await emit(stdout, { ...result, artifact: { ...result.artifact, output: command.output.split(/[\\/]/u).pop() }, localOnly: true }); return; }
  const result = command.operation === 'preflight' ? await application.prepress.runPreflight(document.id, { profile: command.profile, signal }) : command.operation === 'production-validation' ? await application.prepress.runProductionValidation(document.id, { signal }) : command.operation === 'ink-coverage' ? await application.prepress.analyzeInkCoverage(document.id, { signal }) : command.operation === 'separations' ? await application.prepress.renderSeparations(document.id, { page: command.page, dpi: command.dpi, signal }) : await application.prepress.renderOverprintPreview(document.id, { page: command.page, dpi: command.dpi, signal });
  const output = command.operation === 'preflight' && command.format === 'xml'
    ? serializePreflightReportXml(result) : result;
  await outputValue(command, stdout, output, signal);
}
