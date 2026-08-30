import { PopplerAdapter } from '../platform/adapters/poppler.mjs';
import { TesseractAdapter } from '../platform/adapters/tesseract.mjs';
import { OcrImageAdapter } from '../platform/adapters/ocr-image.mjs';
import { GhostscriptAdapter } from '../platform/adapters/ghostscript.mjs';
import { QpdfAdapter } from '../platform/adapters/qpdf.mjs';
import { ImageMagickAdapter } from '../platform/adapters/imagemagick.mjs';
import { LibreOfficeAdapter } from '../platform/adapters/libreoffice.mjs';
import { RasterMutationAdapter } from '../platform/adapters/raster-mutation.mjs';
import { createCupsfilterAdapter } from '../platform/adapters/cupsfilter.mjs';
import { EngineRegistry } from '../platform/runtime/engine-registry.mjs';
import { PdfCertificateSignatureService } from '../application/pdf/pdf-certificate-signature-service.mjs';
import { SigningIdentityDirectoryService } from '../application/security/signing-identity-directory-service.mjs';
import { stageSignatureTrustRuntime, stageSigningIdentityRuntime } from './optional-native-staging.mjs';

export async function createEngineRuntime({ root, sessionRoot, runner, store, inputs, PdfServiceClass }) {
  const registry = new EngineRegistry({ runner });
  const adapter = new PopplerAdapter({ registry, runner });
  const ocrAdapter = new TesseractAdapter({ registry, runner });
  const ocrImageAdapter = new OcrImageAdapter({ registry, runner });
  const ghostscript = new GhostscriptAdapter({ registry, runner });
  const qpdf = new QpdfAdapter({ registry, runner });
  const libreOffice = new LibreOfficeAdapter({ registry, runner });
  const imageMagick = new ImageMagickAdapter({ registry, runner });
  const raster = new RasterMutationAdapter({ registry, runner });
  const cupsfilter = createCupsfilterAdapter({ processRunner: runner });
  const { signatureTrustAdapter, signatureTrustHelper } = await stageSignatureTrustRuntime({ root, sessionRoot, runner });
  const { signingIdentityAdapter, signingIdentityHelper } = await stageSigningIdentityRuntime({ root, sessionRoot, runner });
  const service = new PdfServiceClass({ store, registry, adapter, ocrAdapter, ocrImageAdapter, signatureTrustAdapter });
  const certificateSignature = new PdfCertificateSignatureService({ store, adapter: signingIdentityAdapter });
  const signingIdentityDirectory = new SigningIdentityDirectoryService({ root: sessionRoot, adapter: signingIdentityAdapter });
  return { registry, adapter, ghostscript, qpdf, libreOffice, imageMagick, raster, cupsfilter, service, certificateSignature, signingIdentityDirectory, signatureTrustAdapter, signatureTrustHelper, signingIdentityAdapter, signingIdentityHelper, inputs };
}
