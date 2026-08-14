export const PDF_SIGNATURE_CONTAINER_PROFILE = 'local-pdf-signature-container-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const printable = (value, min, max) => typeof value === 'string' && value === value.normalize('NFC') && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes('\ufffd');
export function normalizeCertificateSignatureRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || ![9, 10].includes(Object.keys(value).length) || Object.keys(value).some((key) => !['profile', 'sourceSha256', 'certificateSha256', 'page', 'fieldName', 'reason', 'location', 'contact', 'placeholderBytes', 'consent'].includes(key)) || value.profile !== PDF_SIGNATURE_CONTAINER_PROFILE || value.consent !== true || !SHA256.test(value.sourceSha256 ?? '') || (Object.hasOwn(value, 'certificateSha256') && !SHA256.test(value.certificateSha256 ?? ''))
    || !Number.isSafeInteger(value.page) || value.page < 1 || !printable(value.fieldName, 1, 127)
    || !printable(value.reason, 0, 255) || !printable(value.location, 0, 255) || !printable(value.contact, 0, 255)
    || !Number.isSafeInteger(value.placeholderBytes) || value.placeholderBytes < 4096 || value.placeholderBytes > 262144) throw new TypeError('Certificate signature options are invalid.');
  return Object.freeze({ profile: PDF_SIGNATURE_CONTAINER_PROFILE, sourceSha256: value.sourceSha256, ...(Object.hasOwn(value, 'certificateSha256') ? { certificateSha256: value.certificateSha256 } : {}), page: value.page, fieldName: value.fieldName, reason: value.reason, location: value.location, contact: value.contact, placeholderBytes: value.placeholderBytes, consent: true });
}
