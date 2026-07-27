export async function runProfessionalCapabilityCommand(application, command, stdout, signal, runtime) {
  runtime.cancelled(signal);
  const capabilityId = command.capabilityId;
  if (typeof capabilityId !== 'string' || !capabilityId) {
    const error = new Error('capabilityId is required');
    error.code = 'INVALID_CLI_ARGUMENTS';
    throw error;
  }
  const context = command.context && typeof command.context === 'object' ? command.context : {};
  const deliver = application.professionalCapabilities?.deliver;
  if (typeof deliver !== 'function') {
    const error = new Error('Professional capability delivery is unavailable');
    error.code = 'PROFESSIONAL_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const result = await deliver(capabilityId, { ...context, signal });
  // Do not dump raw PDF bytes to stdout
  const { pdf, ...rest } = result;
  await runtime.outputValue(command, stdout, pdf ? { ...rest, pdfBytes: pdf.length, hasPdf: true } : rest);
}
