export async function runComparisonCommand(
  application,
  command,
  stdout,
  signal,
  runtime,
) {
  const { uploadPdf, outputValue, cancelled } = runtime;
  const primary = await uploadPdf(application, command.primaryInput, signal);
  cancelled(signal);
  const secondary = await uploadPdf(application, command.secondaryInput, signal);
  cancelled(signal);
  const report = await application.comparisons.compareContent(
    primary.id,
    secondary.id,
    { signal },
  );
  cancelled(signal);
  const exported = application.comparisons.exportContentReport(
    report,
    { format: command.format },
  );
  cancelled(signal);
  await outputValue(command, stdout, exported.data, signal);
}
