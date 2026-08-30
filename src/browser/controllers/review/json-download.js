export function createJsonDownload({ triggerDownload, BlobConstructor, json }) {
  return function jsonDownload(value, fileName, message) {
    triggerDownload({
      blob: new BlobConstructor([json.stringify(value, null, 2)], { type: 'application/json' }),
      fileName,
      message,
    });
  };
}
