import { HostError } from './host-error.mjs';

const PDFSIG_NSS_EMPTY_DATABASE_DIAGNOSTIC = 'NSS_Init failed: security library: bad database.\n';
const PDFSIG_VALIDATION_STATUSES = new Map([
  ['Signature is Valid.', 'valid'],
  ['Signature is Invalid.', 'invalid'],
  ['Digest Mismatch.', 'invalid'],
  ["Document isn't signed or corrupted data.", 'invalid'],
  ['Signature not found.', 'indeterminate'],
  ['Signature has not yet been verified.', 'indeterminate'],
  ['Unknown Validation Failure.', 'indeterminate'],
]);
const SIGNATURE_FIELDS = new Set([
  'Signature Field Name', 'Signer Certificate Common Name', 'Signer fingerprint',
  'Signer full Distinguished Name', 'Signing Time', 'Signing Hash Algorithm',
  'Signature Type', 'Signed Ranges', 'Signature Validation',
]);

function signatureLimitations() {
  return Object.freeze([
    'Certificate trust was not checked.',
    'Revocation, LTV, and trusted timestamps were not checked.',
    'Signer fields are claims embedded in the PDF, not verified identity.',
  ]);
}

function assertExpectedInputPath(expectedInputPath) {
  if (expectedInputPath !== null
    && (typeof expectedInputPath !== 'string' || !expectedInputPath || /[\0\r\n]/u.test(expectedInputPath))) {
    throw new TypeError('expectedInputPath must be a path without NUL or newline bytes');
  }
}

function signatureResult(status, signatures, limitations) {
  const coverageStatus = status === 'unsigned'
    ? 'unsigned'
    : signatures.every(({ documentCoverage }) => documentCoverage === 'full')
      ? 'full'
      : signatures.every(({ documentCoverage }) => documentCoverage === 'prior-revision')
        ? 'prior-revision'
        : 'mixed';
  const currentDocumentStatus = status === 'unsigned'
    ? 'unsigned'
    : status === 'invalid'
      ? 'invalid'
      : status === 'indeterminate'
        ? 'indeterminate'
        : signatures.every(({ documentCoverage }) => documentCoverage === 'full')
          ? 'valid'
          : 'modified-after-signing';
  return Object.freeze({
    schemaVersion: 1,
    profile: 'poppler-offline-integrity-v1',
    status,
    integrityStatus: status,
    coverageStatus,
    currentDocumentStatus,
    count: signatures.length,
    signatureCount: signatures.length,
    summary: status === 'unsigned'
      ? 'No embedded signatures'
      : `${signatures.length} embedded signature${signatures.length === 1 ? '' : 's'} · ${status} integrity evidence`,
    signatures: Object.freeze(signatures),
    limitations,
  });
}

function isUnsignedOutput(text, expectedInputPath) {
  if (expectedInputPath === null) {
    return /^File '[^\r\n]+' does not contain any signatures$/.test(text);
  }
  return text === `File '${expectedInputPath}' does not contain any signatures`;
}

function hasExpectedHeader(lines, expectedInputPath) {
  if (expectedInputPath === null) {
    return /^Digital Signature Info of: [^\r\n]+$/.test(lines[0] ?? '');
  }
  return lines[0] === `Digital Signature Info of: ${expectedInputPath}`;
}

function parseSignatureFields(lines, cursor) {
  const fields = new Map();
  let coverage = 'unknown';
  let coverageLineSeen = false;
  while (cursor < lines.length && !/^Signature #\d+:$/.test(lines[cursor])) {
    const line = lines[cursor];
    if (line === '  - Total document signed' || line === '  - Not total document signed') {
      if (coverageLineSeen) throw signatureOutputError();
      coverageLineSeen = true;
      coverage = line === '  - Total document signed' ? 'full' : 'prior-revision';
    } else {
      const field = line.match(/^  - ([^:]+): (.*)$/);
      if (!field || !SIGNATURE_FIELDS.has(field[1]) || fields.has(field[1])
        || field[2].length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(field[2])) {
        throw signatureOutputError();
      }
      fields.set(field[1], field[2]);
    }
    cursor += 1;
  }
  return { fields, coverage, cursor };
}

function signatureRange(fields) {
  const signedRanges = fields.get('Signed Ranges')?.match(/^\[(\d+) - (\d+)\], \[(\d+) - (\d+)\]$/);
  const values = signedRanges?.slice(1).map(Number) ?? [];
  const valid = values.length === 4 && values.every(Number.isSafeInteger)
    && values[0] === 0 && values[1] > values[0]
    && values[2] > values[1] && values[3] > values[2];
  return { values, valid };
}

function createSignature(fields, coverage, index) {
  const integrity = PDFSIG_VALIDATION_STATUSES.get(fields.get('Signature Validation')) ?? null;
  const hashAlgorithm = fields.get('Signing Hash Algorithm') ?? null;
  const signatureType = fields.get('Signature Type') ?? null;
  const { values, valid } = signatureRange(fields);
  if (!integrity || coverage === 'unknown' || !valid
    || (hashAlgorithm !== null && !/^[A-Za-z0-9-]{1,64}$/.test(hashAlgorithm))
    || (signatureType !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(signatureType))) {
    throw signatureOutputError();
  }
  return Object.freeze({
    index,
    claimedSigner: Object.freeze({
      commonName: fields.get('Signer Certificate Common Name') || null,
      distinguishedName: fields.get('Signer full Distinguished Name') || null,
    }),
    claimedSigningTime: fields.get('Signing Time') || null,
    hashAlgorithm,
    signatureType,
    byteRange: Object.freeze([
      values[0], values[1] - values[0], values[2], values[3] - values[2],
    ]),
    documentCoverage: coverage,
    integrity,
    certificate: 'not-checked',
    revocation: 'not-checked',
    timestamp: 'not-checked',
    identityVerified: false,
  });
}

function summaryStatus(signatures) {
  if (signatures.some(({ integrity }) => integrity === 'invalid')) return 'invalid';
  if (signatures.some(({ integrity }) => integrity === 'indeterminate')) return 'indeterminate';
  return 'valid';
}

export function signatureOutputError(cause) {
  return new HostError(
    'SIGNATURE_OUTPUT_UNRECOGNIZED',
    'Poppler returned unrecognized signature inspection output.',
    502,
    cause ? { cause } : undefined,
  );
}

export function parseSignatures(output, { expectedInputPath = null } = {}) {
  assertExpectedInputPath(expectedInputPath);
  const text = String(output ?? '').replaceAll('\r\n', '\n').trimEnd();
  const limitations = signatureLimitations();
  if (isUnsignedOutput(text, expectedInputPath)) return signatureResult('unsigned', [], limitations);
  const lines = text.split('\n');
  if (!hasExpectedHeader(lines, expectedInputPath)) throw signatureOutputError();
  const signatures = [];
  let cursor = 1;
  while (cursor < lines.length) {
    const heading = lines[cursor]?.match(/^Signature #(\d+):$/);
    if (heading && signatures.length >= 100) {
      throw new HostError('SIGNATURE_LIMIT', 'Offline inspection is limited to 100 embedded signatures.', 422);
    }
    if (!heading || Number(heading[1]) !== signatures.length + 1) throw signatureOutputError();
    const parsed = parseSignatureFields(lines, cursor + 1);
    signatures.push(createSignature(parsed.fields, parsed.coverage, signatures.length + 1));
    cursor = parsed.cursor;
  }
  if (!signatures.length
    || new Set(signatures.map(({ byteRange }) => byteRange.join(':'))).size !== signatures.length) {
    throw signatureOutputError();
  }
  return signatureResult(summaryStatus(signatures), signatures, limitations);
}

export function acceptedPdfsigStderr(stderr) {
  return stderr === '' || stderr === PDFSIG_NSS_EMPTY_DATABASE_DIAGNOSTIC;
}

export async function executeOfflineSignatureInspection(
  adapter,
  { input, nssDirectory, signal, timeoutMs = 30_000 } = {},
) {
  if (!adapter || typeof adapter.execute !== 'function') {
    throw new TypeError('adapter must expose execute(operation, parameters, options)');
  }
  const runOptions = {
    cwd: nssDirectory,
    signal,
    timeoutMs,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 256 * 1024,
  };
  let stdout;
  let stderr;
  let exitCode = 0;
  try {
    const result = await adapter.execute('verifySignatures', { input, nssDirectory }, runOptions);
    ({ stdout, stderr, exitCode = 0 } = result);
  } catch (error) {
    if (error?.exitCode !== 1 && error?.exitCode !== 2) throw error;
    ({ stdout = '', stderr = '', exitCode } = error);
    if (!acceptedPdfsigStderr(stderr)) {
      throw new HostError(
        'SIGNATURE_INSPECTION_UNAVAILABLE',
        'The isolated local signature backend could not be initialized safely.',
        503,
        { cause: error },
      );
    }
    const parsed = parseSignatures(stdout, { expectedInputPath: input });
    const expectedStatus = exitCode === 2
      ? parsed.status === 'unsigned'
      : parsed.status === 'invalid' || parsed.status === 'indeterminate';
    if (!expectedStatus) throw signatureOutputError(error);
    return parsed;
  }
  if (exitCode !== 0 || !acceptedPdfsigStderr(stderr ?? '')) throw signatureOutputError();
  const parsed = parseSignatures(stdout, { expectedInputPath: input });
  if (parsed.status === 'invalid') throw signatureOutputError();
  return parsed;
}
