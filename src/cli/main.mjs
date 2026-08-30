#!/usr/bin/env node

// Platen CLI entry point.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApplication } from '../host/local-host.mjs';
import { CLI_HELP, parseCliArguments } from './parser.mjs';
import * as runtime from './runtime.mjs';
import { runDocumentCommand } from './commands/document.mjs';
import { runAccessibilityMetadataCommand } from './commands/accessibility-metadata.mjs';
import { runOcrCommand } from './commands/ocr.mjs';
import { runBatchOcr } from './commands/ocr-batch.mjs';
import { runWatchOcr } from './commands/watch-ocr.mjs';
import { runPrepressCommand } from './commands/prepress.mjs';
import { runAutomationCommand } from './commands/automation.mjs';
import { runComparisonCommand } from './commands/comparison.mjs';
import { runConversionCommand } from './commands/conversion.mjs';
import { runOfficeConversionCommand } from './commands/office-conversion.mjs';
import { runHtmlConversionCommand } from './commands/html-conversion.mjs';
import { runPostScriptConversionCommand } from './commands/postscript-conversion.mjs';
import { runCadToPdfCommand } from './commands/cad-to-pdf.mjs';
import { runPrintToPdfCommand } from './commands/print-to-pdf.mjs';
import { runStructuredExportLocalCommand } from './commands/structured-export.mjs';
import { runPageImageExportCommand } from './commands/page-image-export.mjs';
import { runOptimizeCompressCommand } from './commands/optimize-compress.mjs';
import { runPluginAllowlistCommand } from './commands/plugin-allowlist.mjs';
import { runLayerDefaultsCommand } from './commands/layer-defaults.mjs';
import { runCertificateSignCommand, runSigningIdentitiesCommand } from './commands/signing.mjs';
import { runHiddenDataSanitizationCommand } from './commands/hidden-data-sanitization.mjs';
import { runAcroFormCheckboxCommand, runAcroFormRadioCommand, runAcroFormTextFieldCommand, runAcroFormSignatureFieldCommand } from './commands/acroform.mjs';
import { runAecMeasurementLegendCommand } from './commands/aec-measurement-legend.mjs';
import { runAecBatchLinkCommand } from './commands/aec-batch-link.mjs';
import { runTaggedRemediationCommand } from './commands/tagged-remediation.mjs';
import { runJpegImageCommand } from './commands/jpeg-image.mjs';
import { runJpegImageReplacementCommand } from './commands/jpeg-image-replacement.mjs';
import { runPageLabelsCommand } from './commands/page-labels.mjs';
import { runAdvancedSearchCommand } from './commands/advanced-search.mjs';
import { runSpecialistContentCommand } from './commands/specialist-content.mjs';
import { runFullPageRedactionBatchCommand } from './commands/full-page-redaction.mjs';
import { runPrinterMarksCommand } from './commands/printer-marks.mjs';
import { runPageBackgroundCommand } from './commands/page-background.mjs';
import { runPageWatermarkCommand } from './commands/page-watermark.mjs';
import { runSnapshotRegionCommand } from './commands/snapshot-region.mjs';
import { runScannerDiscoveryCommand } from './commands/scanner-discovery.mjs';
import { runScanAppendCommand } from './commands/scan-append.mjs';
import { runAcroFormChoiceCommand } from './commands/acroform-choice.mjs';
import { runBatesNumberingCommand } from './commands/bates-numbering.mjs';
import { runPageTransitionCommand } from './commands/page-transition.mjs';
import { runPluginPackageCommand } from './commands/plugin-package.mjs';
import { runAdminPolicyCommand } from './commands/admin-policy.mjs';
import { runAdminAuditCommand } from './commands/admin-audit.mjs';
import { runFastWebViewCommand } from './commands/fast-web-view.mjs';
import { runOoxmlExportCommand } from './commands/ooxml-export.mjs';
import { runProfessionalCapabilityCommand } from './commands/professional-capability.mjs';
import { runTextReflowCommand } from './commands/text-reflow.mjs';
import { createAutomationRecipeCliAuthority } from './automation-recipe-authority.mjs';
import { createAutomationConditionalCliAuthority } from './automation-conditional-authority.mjs';
import { createAutomationSubmitCliAuthority } from './automation-submit-authority.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export { CLI_HELP, parseCliArguments };

export async function runCli(argv, { createApplication = createLocalApplication, stdout = process.stdout, applicationRoot = root, signal } = {}) {
  const command = parseCliArguments(argv);
  if (command.command === 'help') { await runtime.emit(stdout, `${CLI_HELP}\n`); return; }
  const automationRecipeAuthority = command.command === 'automation-run-recipe'
    ? createAutomationRecipeCliAuthority(command) : null;
  const automationConditionalAuthority = command.command === 'automation-run-conditional'
    ? createAutomationConditionalCliAuthority(command) : null;
  const automationSubmitAuthority = command.command.startsWith('automation-submit')
    ? createAutomationSubmitCliAuthority(command) : null;
  const automationCapabilityAuthority = automationRecipeAuthority ?? automationConditionalAuthority
    ?? automationSubmitAuthority;
  const application = await createApplication({
    root: applicationRoot,
    host: '127.0.0.1',
    port: 4173,
    automationRoot: command.automationRoot ?? null,
    ...(command.trustRoot ? { publisherTrustRoot: command.trustRoot } : {}),
    ...(command.pluginRoot ? { pluginPackageRoot: command.pluginRoot } : {}),
    ...(command.policyRoot ? { adminPolicyRoot: command.policyRoot } : {}),
    ...(automationCapabilityAuthority ? { automationCapabilityAuthority } : {}),
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
    if (command.command === 'admin.policy-configuration') {
      await runAdminPolicyCommand(application, command, stdout, signal, runtime);
      return;
    }
    if (command.command === 'admin.audit-telemetry') {
      await runAdminAuditCommand(application, command, stdout, signal, runtime);
      return;
    }
    if (command.command === 'admin.plugin-package') {
      await runPluginPackageCommand(application, command, stdout, signal, runtime);
      return;
    }
    if (command.command === 'compare-content') { await runComparisonCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'convert-local') { await runConversionCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'convert-office-local') { await runOfficeConversionCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'convert-html-local') { await runHtmlConversionCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'convert-postscript-local') { await runPostScriptConversionCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'create-cad-pdf-local') { await runCadToPdfCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'print-to-pdf-local') { await runPrintToPdfCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'create-blank' || command.command === 'inspect' || command.command === 'text' || command.command === 'accessibility-review' || command.command === 'signature-review') { await runDocumentCommand(application, command, stdout, signal, runtime); return; }
    if (command.command === 'fast-web-view') { await runFastWebViewCommand(application, command, await runtime.uploadPdf(application, command.input, signal), stdout, signal, runtime); return; }
    if (command.command === 'ocr' || command.command === 'ocr-layout') { await runOcrCommand(application, command, stdout, signal, runtime); return; }
    const document = await runtime.uploadPdf(application, command.input, signal);
    if (command.command === 'export-structured-local') { await runStructuredExportLocalCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'export-page-png-local') { await runPageImageExportCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'optimize-compress-local') { await runOptimizeCompressCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'accessibility-metadata') { await runAccessibilityMetadataCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'layer-defaults') { await runLayerDefaultsCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'text-reflow') { await runTextReflowCommand(application, command, document, stdout, signal, runtime); return; }
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
    if (command.command === 'page-watermark') { await runPageWatermarkCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'snapshot-region') { await runSnapshotRegionCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'export-ooxml') { await runOoxmlExportCommand(application, command, document, stdout, signal, runtime); return; }
    if (command.command === 'scan-append') { await runScanAppendCommand(application, command, document, stdout, signal, runtime); return; }
    await runPrepressCommand(application, command, document, stdout, signal, runtime);
  } finally { await application.cli.close(); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const controller = new AbortController(); let receivedSignal = null;
  const signalHandlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map((name) => [name, () => { receivedSignal ??= name; controller.abort(new Error(`Received ${name}`)); }]));
  for (const [name, handler] of Object.entries(signalHandlers)) process.once(name, handler);
  try { await runCli(process.argv.slice(2), { signal: controller.signal }); } catch (error) { const code = typeof error?.code === 'string' ? error.code : 'CLI_FAILED'; process.stderr.write(`${JSON.stringify({ error: { code, message: error?.message ?? String(error), status: error?.status ?? null } })}\n`); process.exitCode = receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : 1; } finally { for (const [name, handler] of Object.entries(signalHandlers)) process.removeListener(name, handler); }
}
