export async function readDerivedDocument(context, documentRecord, operation) {
  const {
    client,
    operationIsCurrent,
    removeHostDocument,
    FileCtor,
  } = context;
  const blob = await client.documentSource(documentRecord.id, {
    signal: operation.controller.signal,
  });
  if (!operationIsCurrent(operation)) {
    await removeHostDocument(documentRecord.id);
    return null;
  }
  await removeHostDocument(documentRecord.id);
  return new FileCtor(
    [blob],
    documentRecord.displayName || 'derived-document.pdf',
    { type: 'application/pdf' },
  );
}
