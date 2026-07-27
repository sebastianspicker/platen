import {
  CLEANUP_PRESETS,
  DOCUMENT_ID,
  exactObject,
  freeze,
  invalid,
  LANGUAGE_TOKEN,
  OCR_LIMITS,
  positiveInteger,
  SEGMENTATION_MODES,
  ZONE_ID,
  ZONE_TYPES,
} from './ocr-contract-shared.js';

function languageSet(installedLanguages) {
  if (!Array.isArray(installedLanguages) || !installedLanguages.length
    || installedLanguages.some((language) => (
      typeof language !== 'string' || !LANGUAGE_TOKEN.test(language)
    ))) {
    invalid('Installed OCR languages must be strict language tokens.');
  }
  return new Set(installedLanguages);
}

export function validateInstalledOcrLanguage(value, installedLanguages) {
  const installed = languageSet(installedLanguages);
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('\0')) {
    invalid('OCR language is invalid.');
  }
  const tokens = value.split('+');
  if (!tokens.length || tokens.some((token) => (
    !LANGUAGE_TOKEN.test(token) || !installed.has(token)
  )) || new Set(tokens).size !== tokens.length) {
    invalid('OCR language must name installed strict language tokens.');
  }
  return tokens.join('+');
}

function mode(value, allowed, label, fallback) {
  const normalized = value ?? fallback;
  if (!allowed.includes(normalized)) invalid(`${label} is invalid.`);
  return normalized;
}

function normalizePages(value) {
  if (!Array.isArray(value) || !value.length || value.length > OCR_LIMITS.maxLayoutPages) {
    invalid('OCR pages are invalid.');
  }
  const pages = value.map((page) => positiveInteger(page, 'OCR page', 1_000_000));
  if (new Set(pages).size !== pages.length) invalid('OCR pages must be unique.');
  return pages;
}

function normalizedZone(value, pages) {
  exactObject(value, ['id', 'type', 'page', 'x', 'y', 'width', 'height'], 'OCR zone');
  if (typeof value.id !== 'string' || !ZONE_ID.test(value.id)) invalid('OCR zone ID is unsafe.');
  if (!ZONE_TYPES.includes(value.type)) invalid('OCR zone type is invalid.');
  if (!Number.isSafeInteger(value.page) || !pages.includes(value.page)) {
    invalid('OCR zone page must be selected.');
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(value[key])) invalid(`OCR zone ${key} must be finite.`);
  }
  if (value.x < 0 || value.y < 0
    || value.width < OCR_LIMITS.minNormalizedZoneSize
    || value.height < OCR_LIMITS.minNormalizedZoneSize
    || value.x + value.width > 1 || value.y + value.height > 1) {
    invalid('OCR zone is outside the normalized page or too small for the local raster.');
  }
  return {
    id: value.id,
    type: value.type,
    page: value.page,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function overlaps(first, second) {
  return first.page === second.page
    && first.x < second.x + second.width && second.x < first.x + first.width
    && first.y < second.y + second.height && second.y < first.y + first.height;
}

function normalizeZones(value, pages) {
  if (!Array.isArray(value) || value.length > OCR_LIMITS.maxZones) {
    invalid(`Choose at most ${OCR_LIMITS.maxZones} OCR zones.`);
  }
  const zones = value.map((zone) => normalizedZone(zone, pages));
  if (new Set(zones.map(({ id }) => id)).size !== zones.length) {
    invalid('OCR zone IDs must be unique.');
  }
  for (const page of pages) {
    if (zones.filter((zone) => zone.page === page).length > OCR_LIMITS.maxZonesPerPage) {
      invalid(`Choose at most ${OCR_LIMITS.maxZonesPerPage} OCR zones per page.`);
    }
  }
  for (let index = 0; index < zones.length; index += 1) {
    for (let other = index + 1; other < zones.length; other += 1) {
      if (overlaps(zones[index], zones[other])) {
        invalid('OCR zones must not overlap on a page.');
      }
    }
  }
  return zones;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function normalizeOcrUserDictionary(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > OCR_LIMITS.maxUserDictionaryTerms) {
    invalid(`OCR user dictionary must contain at most ${OCR_LIMITS.maxUserDictionaryTerms} terms.`);
  }
  const terms = value.map((term) => {
    if (typeof term !== 'string' || hasUnpairedSurrogate(term)) invalid('OCR user dictionary term is invalid.');
    const normalized = term.trim().normalize('NFC');
    if (!normalized || normalized.length > OCR_LIMITS.maxUserDictionaryTermLength
      || /^(?:\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/u.test(normalized)
      || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
      invalid('OCR user dictionary term is unsafe.');
    }
    return normalized;
  });
  if (new Set(terms).size !== terms.length
    || terms.join('').length > OCR_LIMITS.maxUserDictionaryCharacters) {
    invalid('OCR user dictionary terms must be unique and bounded.');
  }
  return freeze(terms);
}

export function normalizeOcrDocumentRequest(value, installedLanguages) {
  exactObject(value, ['language', 'cleanupPreset', 'segmentation', 'userDictionary'], 'OCR document request');
  return freeze({
    language: validateInstalledOcrLanguage(value.language ?? 'eng', installedLanguages),
    cleanupPreset: mode(value.cleanupPreset, CLEANUP_PRESETS, 'OCR cleanup preset', 'document'),
    segmentation: mode(value.segmentation, SEGMENTATION_MODES, 'OCR segmentation', 'auto'),
    userDictionary: normalizeOcrUserDictionary(value.userDictionary),
  });
}

export function normalizeOcrLayoutRequest(value, installedLanguages) {
  exactObject(
    value,
    ['language', 'pages', 'zones', 'cleanupPreset', 'segmentation', 'detectTables'],
    'OCR layout request',
  );
  const pages = normalizePages(value.pages ?? [1]);
  if (value.detectTables !== undefined && typeof value.detectTables !== 'boolean') {
    invalid('OCR table detection must be a boolean.');
  }
  return freeze({
    language: validateInstalledOcrLanguage(value.language ?? 'eng', installedLanguages),
    pages,
    zones: normalizeZones(value.zones ?? [], pages),
    cleanupPreset: mode(value.cleanupPreset, CLEANUP_PRESETS, 'OCR cleanup preset', 'document'),
    segmentation: mode(value.segmentation, SEGMENTATION_MODES, 'OCR segmentation', 'auto'),
    detectTables: value.detectTables ?? true,
  });
}

export function normalizeOcrBatchRequest(value, installedLanguages) {
  exactObject(value, ['requests'], 'OCR batch request');
  if (!Array.isArray(value.requests) || !value.requests.length
    || value.requests.length > OCR_LIMITS.maxBatchRequests) {
    invalid(`OCR batch must contain 1 through ${OCR_LIMITS.maxBatchRequests} requests.`);
  }
  const requests = value.requests.map((request, index) => {
    exactObject(request, ['id', 'documentId', 'kind', 'options'], 'OCR batch entry');
    positiveInteger(request.id, 'OCR batch request ID', OCR_LIMITS.maxBatchRequests);
    if (request.id !== index + 1) {
      invalid('OCR batch request IDs must match their one-based order.');
    }
    if (typeof request.documentId !== 'string' || !DOCUMENT_ID.test(request.documentId)) {
      invalid('OCR batch document ID is unsafe.');
    }
    if (request.kind !== 'document') {
      invalid('OCR batch accepts searchable-document jobs only.');
    }
    return {
      id: request.id,
      documentId: request.documentId,
      kind: 'document',
      options: normalizeOcrDocumentRequest(request.options, installedLanguages),
    };
  });
  if (new Set(requests.map(({ id }) => id)).size !== requests.length) {
    invalid('OCR batch request IDs must be unique.');
  }
  return freeze({ requests });
}
