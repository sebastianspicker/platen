#!/usr/bin/env node

// Platen CLI entry point.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApplication } from './local-host.mjs';
import { CLI_HELP, parseCliArguments } from './cli/parser.mjs';
import * as runtime from './cli/runtime.mjs';
import { runDocumentCommand } from './cli/commands/document.mjs';
import { runAccessibilityMetadataCommand } from './cli/commands/accessibility-metadata.mjs';
import { runOcrCommand } from './cli/commands/ocr.mjs';
import { runBatchOcr } from './cli/commands/ocr-batch.mjs';
import { runWatchOcr } from './cli/commands/watch-ocr.mjs';
import { runPrepressCommand } from './cli/commands/prepress.mjs';
import { runAutomationCommand } from './cli/commands/automation.mjs';
import { runComparisonCommand } from './cli/commands/comparison.mjs';
import { runConversionCommand } from './cli/commands/conversion.mjs';
import { runPluginAllowlistCommand } from './cli/commands/plugin-allowlist.mjs';
import { runLayerDefaultsCommand } from './cli/commands/layer-defaults.mjs';
import { runCertificateSignCommand, runSigningIdentitiesCommand } from './cli/commands/signing.mjs';
import { runHiddenDataSanitizationCommand } from './cli/commands/hidden-data-sanitization.mjs';
import { runAcroFormCheckboxCommand, runAcroFormRadioCommand, runAcroFormTextFieldCommand, runAcroFormSignatureFieldCommand } from './cli/commands/acroform.mjs';
import { runAecMeasurementLegendCommand } from './cli/commands/aec-measurement-legend.mjs';
import { runAecBatchLinkCommand } from './cli/commands/aec-batch-link.mjs';
import { runTaggedRemediationCommand } from './cli/commands/tagged-remediation.mjs';
import { runJpegImageCommand } from './cli/commands/jpeg-image.mjs';
import { runJpegImageReplacementCommand } from './cli/commands/jpeg-image-replacement.mjs';
import { runPageLabelsCommand } from './cli/commands/page-labels.mjs';
import { runAdvancedSearchCommand } from './cli/commands/advanced-search.mjs';
import { runSpecialistContentCommand } from './cli/commands/specialist-content.mjs';
import { runFullPageRedactionBatchCommand } from './cli/commands/full-page-redaction.mjs';
import { runPrinterMarksCommand } from './cli/commands/printer-marks.mjs';
import { runPageBackgroundCommand } from './cli/commands/page-background.mjs';
import { runSnapshotRegionCommand } from './cli/commands/snapshot-region.mjs';
import { runScannerDiscoveryCommand } from './cli/commands/scanner-discovery.mjs';
import { runScanAppendCommand } from './cli/commands/scan-append.mjs';
import { runAcroFormChoiceCommand } from './cli/commands/acroform-choice.mjs';
import { runBatesNumberingCommand } from './cli/commands/bates-numbering.mjs';
import { runPageTransitionCommand } from './cli/commands/page-transition.mjs';
import { runPluginPackageCommand } from './cli/commands/plugin-package.mjs';
import { runFastWebViewCommand } from './cli/commands/fast-web-view.mjs';
import { runOoxmlExportCommand } from './cli/commands/ooxml-export.mjs';
import { runProfessionalCapabilityCommand } from './cli/commands/professional-capability.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export { CLI_HELP, parseCliArguments };

export async function runCli(argv, { createApplication = createLocalApplication, stdout = process.stdout, applicationRoot = root, signal } = {}) {
  const command = parseCliArguments(argv);
  if (command.command === 'help') { await runtime.emit(stdout, `${CLI_HELP}\n`); return; }
  const application = await createApplication({
    root: applicationRoot,
    host: '127.0.0.1',
    port: 4173,
    automationRoot: command.automationRoot ?? null,
    ...(command.trustRoot ? { publisherTrustRoot: command.trustRoot } : {}),
    ...(command.pluginRoot ? { pluginPackageRoot: command.pluginRoot } : {}),
  });
  try {
    runtime.cancelled(signal);
    if (command.command === 'professional-capability') { await runProfessionalCapabilityCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'engines') { await runtime.outputValue(command, stdout, { localOnly: true, engines: await application.service.availability() }); return; }
    if (command.command === 'signing-identities') { await runSigningIdentitiesCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'scanner-discovery') { if (!application.scannerDiscovery) { const error = new Error('The scanner discovery helper is unavailable.'); error.code = 'SCANNER_DISCOVERY_UNAVAILABLE'; throw error; } await runScannerDiscoveryCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'ocr-batch') { await runBatchOcr(application, command, stdout, signal, runtime); return; }
    if (command.command === 'watch-ocr') { await runWatchOcr(application, command, stdout, signal, runtime); return; }
    if (command.command.startsWith('automation-')) { await runAutomationCommand(application, command, stdout, runtime, signal); return; }
    if (command.command === 'admin.plugin-allowlist') {
      await runPluginAllowlistCommand(application, command, stdout, signal, runtime);
      return;
    }
    if (command.command === 'admin.plugin-package') {
      await runPluginPackageCommand(application, command, stdout, signal, runtime);
      return;
    }
    if (command.command === 'compare-content') { await runComparisonCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'convert-local') { await runConversionCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'create-blank' || command.command === 'inspect' || command.command === 'text' || command.command === 'accessibility-review' || command.command === 'signature-review') { await runDocumentCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'fast-web-view') { await runFastWebViewCommand(application, command, await runtime.uploadPdf(application, command.input, signal), stdout, signal, runtime); return; }
    if (command.command === 'ocr' || command.command === 'ocr-layout') { await runOcrCommand(application, command, stdout, signal, runtime); return; }
    const document = await runtime.uploadPdf(application, command.input, signal);
    if (command.command === 'accessibility-metadata') { await runAccessibilityMetadataCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'layer-defaults') { await runLayerDefaultsCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'certificate-sign') { await runCertificateSignCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'sanitize-hidden-data') { await runHiddenDataSanitizationCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'add-checkbox') { await runAcroFormCheckboxCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'add-radio-group') { await runAcroFormRadioCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'acroform-text-field') { await runAcroFormTextFieldCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'acroform-signature-field') { await runAcroFormSignatureFieldCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'acroform-choice') { await runAcroFormChoiceCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'bates-numbering') { await runBatesNumberingCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'page-transition') { await runPageTransitionCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'aec-measurement-legend') { await runAecMeasurementLegendCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'aec-batch-link') { await runAecBatchLinkCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'tagged-remediation') { await runTaggedRemediationCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'insert-jpeg') { await runJpegImageCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'replace-jpeg') { await runJpegImageReplacementCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'page-labels') { await runPageLabelsCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'advanced-search') { await runAdvancedSearchCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'specialist-content') { await runSpecialistContentCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'redact-pages') { await runFullPageRedactionBatchCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'printer-marks') { await runPrinterMarksCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'page-background') { await runPageBackgroundCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'snapshot-region') { await runSnapshotRegionCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'export-ooxml') { await runOoxmlExportCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'scan-append') { await runScanAppendCommand(application, command, document, stdout, signal, runtime); return; }
    await runPrepressCommand(application, command, document, stdout, signal, runtime);
  } finally { await (application.close?.() ?? application.store.dispose()); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const controller = new AbortController(); let receivedSignal = null;
  const signalHandlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map((name) => [name, () => { receivedSignal ??= name; controller.abort(new Error(`Received ${name}`)); }]));
  for (const [name, handler] of Object.entries(signalHandlers)) process.once(name, handler);
  try { await runCli(process.argv.slice(2), { signal: controller.signal }); } catch (error) { const code = typeof error?.code === 'string' ? error.code : 'CLI_FAILED'; process.stderr.write(`${JSON.stringify({ error: { code, message: error?.message ?? String(error), status: error?.status ?? null } })}\n`); process.exitCode = receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : 1; } finally { for (const [name, handler] of Object.entries(signalHandlers)) process.removeListener(name, handler); }
}
