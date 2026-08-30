export const MAX_BROWSER_VERIFIED_OCR_BYTES = 64 * 1024 * 1024;

export async function verifyOcrArtifactBlob(artifact, blob, { cryptoApi = globalThis.crypto } = {}) {
  if (artifact?.size > MAX_BROWSER_VERIFIED_OCR_BYTES
    || !artifact || typeof artifact?.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    || !(blob instanceof Blob) || blob.size !== artifact.size
    || typeof cryptoApi?.subtle?.digest !== 'function') {
    throw new Error('The local OCR artifact cannot be verified in this browser.');
  }
  const bytes = await blob.arrayBuffer();
  const digest = [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== artifact.sha256) {
    throw new Error('The downloaded OCR artifact digest does not match its source-bound record.');
  }
  return blob;
}
