import {
  digest, fail, id, list, plain, text,
} from './aec-collaboration-support.mjs';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function invalidDrawingSet(message) {
  fail('INVALID_DRAWING_SET', message);
}

function sourceBoundSheets(value) {
  const sheets = list(value, 'sheets', 100);
  if (sheets.length < 1) invalidDrawingSet('Source-bound drawing sets require at least one sheet.');

  const normalized = sheets.map((sheet, index) => {
    try {
      return id(sheet, `sheets[${index}]`);
    } catch {
      invalidDrawingSet(`Source-bound sheet ${index} identifier is invalid.`);
    }
  });
  if (new Set(normalized).size !== normalized.length) {
    invalidDrawingSet('Source-bound drawing sets must not contain duplicate sheet identifiers.');
  }
  return normalized;
}

function sourceBoundInitialLog(value) {
  if (!plain(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'revisionLabel') || !Object.hasOwn(value, 'date')) {
    invalidDrawingSet('Source-bound initialLog must contain exactly revisionLabel and date.');
  }

  const revisionLabel = text(value.revisionLabel, 'initialLog.revisionLabel', 80);
  const date = text(value.date, 'initialLog.date', 10);
  const match = ISO_DATE.exec(date);
  if (!match) invalidDrawingSet('Source-bound initialLog.date must be an ISO date (YYYY-MM-DD).');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) {
    invalidDrawingSet('Source-bound initialLog.date must be a valid ISO date (YYYY-MM-DD).');
  }
  return { revisionLabel, date };
}

/** Store a local drawing set and exactly one initial revision-log entry. */
export function createDrawingSet(
  domain,
  documentId,
  input,
  options = {},
) {
  if (!plain(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    invalidDrawingSet('Drawing-set input must be a plain object.');
  }
  const {
    id: suppliedId, name, sheets, initialLog, sourceSha256,
  } = input;
  if (sourceSha256 === undefined) {
    if (initialLog !== undefined) {
      invalidDrawingSet('An initial drawing log requires a source-bound drawing set.');
    }
    const record = {
      id: domain.newId('drawing-set', suppliedId),
      type: 'drawing-set',
      name: text(name, 'name'),
      sheets: list(sheets, 'sheets', 100).map((sheet) => id(sheet, 'sheet id')),
      createdAt: domain.now(),
    };
    return domain.write(documentId, 'reviewRecords', record, options.expectedRevision);
  }

  const allowedKeys = ['id', 'name', 'sheets', 'initialLog', 'sourceSha256'];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))
    || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'sheets')
    || !Object.hasOwn(input, 'initialLog')) {
    invalidDrawingSet('Source-bound drawing-set input contains unexpected or missing fields.');
  }

  const snapshot = domain.snapshot(documentId);
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0
    || options.expectedRevision !== snapshot.revision) {
    fail('REVISION_CONFLICT', 'Source-bound drawing-set creation requires the current workspace revision.', 409);
  }

  const source = digest(sourceSha256, 'sourceSha256');
  const record = {
    id: domain.newId('drawing-set', suppliedId),
    type: 'drawing-set',
    name: text(name, 'name'),
    sheets: sourceBoundSheets(sheets),
    initialLog: sourceBoundInitialLog(initialLog),
    sourceSha256: source,
    basisRevision: snapshot.revision,
    createdAt: domain.now(),
  };
  return domain.write(documentId, 'reviewRecords', record, options.expectedRevision);
}
