import {
  findFinalStartXref,
  parseClassicXrefSection,
  parsePdfIndirectObject,
  pdfDictionary,
  pdfInteger,
  pdfReference,
} from './pdf-classic-syntax.mjs';

const PDFKIT_PERMISSION_VALUES = Object.freeze([-3904, -3392, -3376, -1852]);
const PDFKIT_ENCRYPTION_KEYS = new Set([
  'Filter', 'V', 'R', 'Length', 'P', 'O', 'U', 'CF', 'StmF', 'StrF', 'EncryptMetadata',
]);

function invalid() {
  const error = new Error('PDF encryption envelope is not the fixed supported AES-128 profile.');
  error.code = 'INVALID_ENCRYPTION_ENVELOPE';
  return error;
}

function name(value) {
  if (value?.type !== 'name') throw invalid();
  return value.value;
}

function exactHexString(value, byteLength) {
  return value?.type === 'string' && value.format === 'hex'
    && Buffer.isBuffer(value.bytes) && value.bytes.length === byteLength;
}

function finalSection(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) throw invalid();
  const section = parseClassicXrefSection(buffer, findFinalStartXref(buffer));
  if (section.trailer.has('Prev') || section.trailer.has('XRefStm')) throw invalid();
  return section;
}

function referencedDictionary(buffer, section, value) {
  const reference = pdfReference(value);
  const entry = section.entries.find((candidate) => candidate.status === 'n'
    && candidate.object === reference.object && candidate.generation === reference.generation);
  if (!entry) throw invalid();
  const object = parsePdfIndirectObject(buffer, entry.offset, reference);
  if (object.stream) throw invalid();
  return pdfDictionary(object.value);
}

function inspectSupported(buffer, expectedPermissions) {
  if (expectedPermissions !== null
    && (!Number.isSafeInteger(expectedPermissions) || !PDFKIT_PERMISSION_VALUES.includes(expectedPermissions))) {
    throw invalid();
  }
  const section = finalSection(buffer);
  const encryption = referencedDictionary(buffer, section, section.trailer.get('Encrypt'));
  const cryptFilters = pdfDictionary(encryption.get('CF'));
  if (cryptFilters.size !== 1 || !cryptFilters.has('StdCF')) throw invalid();
  const standardFilter = pdfDictionary(cryptFilters.get('StdCF'));
  const encryptMetadata = encryption.has('EncryptMetadata')
    ? encryption.get('EncryptMetadata') : Object.freeze({ type: 'boolean', value: true });
  const permissionsRaw = pdfInteger(encryption.get('P'));
  if (name(encryption.get('Filter')) !== 'Standard'
    || pdfInteger(encryption.get('V')) !== 4 || pdfInteger(encryption.get('R')) !== 4
    || pdfInteger(encryption.get('Length')) !== 128
    || !PDFKIT_PERMISSION_VALUES.includes(permissionsRaw)
    || (expectedPermissions !== null && permissionsRaw !== expectedPermissions)
    || name(encryption.get('StmF')) !== 'StdCF' || name(encryption.get('StrF')) !== 'StdCF'
    || !exactHexString(encryption.get('O'), 32) || !exactHexString(encryption.get('U'), 32)
    || [...encryption.keys()].some((key) => !PDFKIT_ENCRYPTION_KEYS.has(key))
    || encryptMetadata.type !== 'boolean' || encryptMetadata.value !== true
    || standardFilter.size > 3 || name(standardFilter.get('CFM')) !== 'AESV2'
    || pdfInteger(standardFilter.get('Length')) !== 16
    || (standardFilter.has('AuthEvent') && name(standardFilter.get('AuthEvent')) !== 'DocOpen')) throw invalid();
  return Object.freeze({
    handler: 'Standard', version: 4, revision: 4, keyLengthBits: 128,
    cipher: 'AESV2', cryptFilter: 'StdCF', streamFilter: 'StdCF', stringFilter: 'StdCF',
    encryptMetadata: true, permissionsRaw,
  });
}

function envelope(operation) {
  try { return operation(); } catch { throw invalid(); }
}

export function inspectPdfKitAes128Envelope(buffer, { expectedPermissions } = {}) {
  return envelope(() => inspectSupported(buffer, expectedPermissions));
}

export function inspectAnySupportedPdfKitAes128Envelope(buffer) {
  return envelope(() => inspectSupported(buffer, null));
}

export function inspectUnencryptedClassicPdfEnvelope(buffer) {
  return envelope(() => {
    const section = finalSection(buffer);
    if (section.trailer.has('Encrypt')) throw invalid();
    pdfReference(section.trailer.get('Root'));
    if (pdfInteger(section.trailer.get('Size')) < 1) throw invalid();
    return Object.freeze({ encrypted: false, format: 'classic-xref' });
  });
}
