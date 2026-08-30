import { stagePdfKitRuntime, stageScannerDiscoveryRuntime, stageStandardsValidationRuntime } from './optional-native-staging.mjs';

export async function createOptionalRuntime({ root, sessionRoot, runner, store, service, adapter }) {
  const { standardsValidations, standardsValidator } = await stageStandardsValidationRuntime({ root, sessionRoot, runner, store });
  const pdfkit = await stagePdfKitRuntime({ root, sessionRoot, runner, store, pdfService: service, poppler: adapter });
  const scanner = await stageScannerDiscoveryRuntime({ root, sessionRoot, runner, store, inspection: service });
  return { standardsValidations, standardsValidator, ...pdfkit, ...scanner };
}
