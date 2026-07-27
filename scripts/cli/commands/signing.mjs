import { basename } from 'node:path';
import { PDF_SIGNATURE_CONTAINER_PROFILE } from '../../host/pdf-signature-container-writer.mjs';

export async function runSigningIdentitiesCommand(application, command, stdout, signal, runtime) {
  runtime.cancelled(signal);
  const identities = await application.signingIdentityDirectory.list({ signal });
  await runtime.outputValue(command, stdout, { identities }, signal);
}

export async function runCertificateSignCommand(application, command, document, stdout, signal, runtime) {
  const result = await application.certificateSignature.sign(document.id, {
    profile: PDF_SIGNATURE_CONTAINER_PROFILE,
    sourceSha256: document.sha256,
    page: command.page,
    fieldName: command.fieldName,
    reason: command.reason,
    location: command.location,
    contact: command.contact,
    placeholderBytes: command.placeholderBytes,
  }, { certificateSha256: command.certificateSha256, signal });
  runtime.cancelled(signal);
  const artifact = application.store.getArtifact(result.artifact.id);
  await runtime.copyExclusive(artifact.filePath, command.output);
  await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
}
