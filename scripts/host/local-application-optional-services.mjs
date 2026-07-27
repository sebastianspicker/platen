import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFKitAdapter } from './adapters/pdfkit.mjs';
import { SignatureTrustAdapter } from './adapters/signature-trust.mjs';
import { SigningIdentityAdapter } from './adapters/signing-identity.mjs';
import { VeraPdfAdapter } from './adapters/verapdf.mjs';
import { stagePdfKitHelper, verifyStagedPdfKitHelper } from './pdfkit-helper-loader.mjs';
import { PdfKitInspectionService } from './pdfkit-inspection-service.mjs';
import { PdfKitMutationService } from './pdfkit-mutation-service.mjs';
import { PdfKitOutlineSplitService } from './pdfkit-outline-split-service.mjs';
import { PdfKitProtectionService } from './pdfkit-protection-service.mjs';
import { PdfKitSanitizationService } from './pdfkit-sanitization-service.mjs';
import { PdfKitTextFieldWidgetService } from './pdfkit-text-field-widget-service.mjs';
import {
  stageSignatureTrustHelper,
  verifyStagedSignatureTrustHelper,
} from './signature-trust-helper-loader.mjs';
import {
  stageSigningIdentityHelper,
  verifyStagedSigningIdentityHelper,
} from './signing-identity-helper-loader.mjs';
import { loadVeraPdfBundle } from './verapdf-bundle-loader.mjs';
import { VeraPdfValidationService } from './verapdf-validation-service.mjs';
import { stageScannerDiscoveryHelper, verifyStagedScannerDiscoveryHelper } from './scanner-discovery-helper-loader.mjs';
import { ScannerDiscoveryService } from './scanner-discovery-service.mjs';
import { ScannerAcquisitionService } from './scanner-acquisition-service.mjs';
import { ScannerDuplexFeederService } from './scanner-duplex-service.mjs';

export async function stageSignatureTrustRuntime({ root, sessionRoot, runner }) {
  let signatureTrustAdapter = null;
  let signatureTrustHelper = Object.freeze({ available: false, reason: 'unavailable' });
  try {
    const stagedHelper = await stageSignatureTrustHelper({ root, sessionRoot });
    if (stagedHelper.available) {
      signatureTrustAdapter = new SignatureTrustAdapter({
        executable: stagedHelper.executable,
        expectedSha256: stagedHelper.sha256,
        verifyExecutable: verifyStagedSignatureTrustHelper,
        runner,
      });
      signatureTrustHelper = Object.freeze({ available: true, kind: stagedHelper.kind });
    } else {
      signatureTrustHelper = Object.freeze({ available: false, reason: stagedHelper.reason });
    }
  } catch {
    signatureTrustAdapter = null;
    signatureTrustHelper = Object.freeze({ available: false, reason: 'trust-check-failed' });
  }
  return { signatureTrustAdapter, signatureTrustHelper };
}

export async function stageSigningIdentityRuntime({ root, sessionRoot, runner }) {
  let signingIdentityAdapter = null;
  let signingIdentityHelper = Object.freeze({ available: false, reason: 'unavailable' });
  try {
    const stagedHelper = await stageSigningIdentityHelper({ root, sessionRoot });
    if (stagedHelper.available) {
      signingIdentityAdapter = new SigningIdentityAdapter({
        executable: stagedHelper.executable,
        expectedSha256: stagedHelper.sha256,
        verifyExecutable: verifyStagedSigningIdentityHelper,
        runner,
      });
      signingIdentityHelper = Object.freeze({ available: true, kind: stagedHelper.kind });
    } else {
      signingIdentityHelper = Object.freeze({ available: false, reason: stagedHelper.reason });
    }
  } catch {
    signingIdentityAdapter = null;
    signingIdentityHelper = Object.freeze({ available: false, reason: 'trust-check-failed' });
  }
  return { signingIdentityAdapter, signingIdentityHelper };
}

async function createProbeEnvironment(standardsProbeRoot) {
  const probeEnvironment = {};
  for (const [key, name] of [
    ['HOME', 'home'],
    ['TMPDIR', 'tmp'],
    ['XDG_CACHE_HOME', 'cache'],
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_RUNTIME_DIR', 'runtime'],
  ]) {
    const directory = join(standardsProbeRoot, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    probeEnvironment[key] = directory;
  }
  return probeEnvironment;
}

export async function stageStandardsValidationRuntime({ root, sessionRoot, runner, store }) {
  let standardsValidations = null;
  let standardsValidator = Object.freeze({ available: false, reason: 'bundle-not-staged' });
  let standardsProbeRoot = null;
  try {
    const bundle = await loadVeraPdfBundle({ root: join(root, 'vendor', 'verapdf') });
    if (bundle) {
      standardsProbeRoot = await mkdtemp(join(sessionRoot, 'verapdf-probe-'));
      await chmod(standardsProbeRoot, 0o700);
      const probeEnvironment = await createProbeEnvironment(standardsProbeRoot);
      const verapdf = new VeraPdfAdapter({ bundle, runner });
      const probe = await verapdf.probe({ cwd: standardsProbeRoot, environment: probeEnvironment });
      standardsValidations = new VeraPdfValidationService({
        store,
        adapter: verapdf,
        engine: {
          version: probe.version,
          bundleSha256: bundle.evidence.bundleDigest,
          profileNames: probe.profileNames,
        },
      });
      standardsValidator = Object.freeze({ available: true, name: 'veraPDF', version: probe.version });
    }
  } catch {
    standardsValidations = null;
    standardsValidator = Object.freeze({ available: false, reason: 'trust-or-probe-failed' });
  } finally {
    if (standardsProbeRoot) {
      try {
        await rm(standardsProbeRoot, { recursive: true, force: true });
      } catch {
        standardsValidations = null;
        standardsValidator = Object.freeze({ available: false, reason: 'probe-cleanup-failed' });
      }
    }
  }
  return { standardsValidations, standardsValidator };
}

export async function stagePdfKitRuntime({ root, sessionRoot, runner, store, pdfService, poppler }) {
  const runtime = {
    pdfkitInspections: null,
    pdfkitMutations: null,
    pdfkitProtection: null,
    pdfkitSanitization: null,
    pdfkitTextFieldWidget: null,
    pdfkitOutlineSplits: null,
    pdfkitAdapter: null,
    pdfkitHelper: Object.freeze({ available: false, reason: 'unavailable' }),
  };
  try {
    const stagedHelper = await stagePdfKitHelper({ root, sessionRoot });
    if (!stagedHelper.available) {
      runtime.pdfkitHelper = Object.freeze({ available: false, reason: stagedHelper.reason });
      return runtime;
    }
    runtime.pdfkitAdapter = new PDFKitAdapter({
      executable: stagedHelper.executable,
      expectedSha256: stagedHelper.sha256,
      verifyExecutable: verifyStagedPdfKitHelper,
      runner,
    });
    runtime.pdfkitInspections = new PdfKitInspectionService({
      store,
      pdfService,
      adapter: runtime.pdfkitAdapter,
    });
    runtime.pdfkitOutlineSplits = new PdfKitOutlineSplitService({
      store,
      pdfService,
      pdfkitInspectionService: runtime.pdfkitInspections,
    });
    runtime.pdfkitMutations = new PdfKitMutationService({
      store,
      poppler,
      adapter: runtime.pdfkitAdapter,
    });
    runtime.pdfkitProtection = new PdfKitProtectionService({
      store,
      pdfService,
      poppler,
      adapter: runtime.pdfkitAdapter,
    });
    runtime.pdfkitSanitization = new PdfKitSanitizationService({
      store,
      poppler,
      adapter: runtime.pdfkitAdapter,
    });
    runtime.pdfkitTextFieldWidget = new PdfKitTextFieldWidgetService({
      store,
      poppler,
      adapter: runtime.pdfkitAdapter,
    });
    runtime.pdfkitHelper = Object.freeze({ available: true, kind: stagedHelper.kind });
  } catch {
    // A missing or unsafe optional helper must never widen into unpinned execution.
    runtime.pdfkitHelper = Object.freeze({ available: false, reason: 'trust-check-failed' });
  }
  return runtime;
}

export async function stageScannerDiscoveryRuntime({ root, sessionRoot, runner, store, inspection }) {
  try {
    const staged = await stageScannerDiscoveryHelper({ root, sessionRoot });
    if (!staged.available) return { scannerDiscovery: null, scannerAcquisition: null, scannerDuplexFeeder: null, scannerDiscoveryHelper: Object.freeze({ available: false, reason: staged.reason }) };
    const scannerDiscovery = new ScannerDiscoveryService({ executable: staged.executable, expectedSha256: staged.sha256, runner, verifyExecutable: verifyStagedScannerDiscoveryHelper });
    const scannerAcquisition = store ? new ScannerAcquisitionService({ executable: staged.executable, expectedSha256: staged.sha256, runner, verifyExecutable: verifyStagedScannerDiscoveryHelper, workspaceRoot: sessionRoot, store }) : null;
    const scannerDuplexFeeder = store && inspection ? new ScannerDuplexFeederService({ executable: staged.executable, expectedSha256: staged.sha256, runner, verifyExecutable: verifyStagedScannerDiscoveryHelper, workspaceRoot: sessionRoot, store, inspection }) : null;
    return { scannerDiscovery, scannerAcquisition, scannerDuplexFeeder, scannerDiscoveryHelper: Object.freeze({ available: true, kind: staged.kind }) };
  } catch {
    return { scannerDiscovery: null, scannerAcquisition: null, scannerDuplexFeeder: null, scannerDiscoveryHelper: Object.freeze({ available: false, reason: 'trust-check-failed' }) };
  }
}
