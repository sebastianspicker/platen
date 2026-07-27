import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  PDF_SPELLCHECK_PROFILE,
  normalizePdfSpellcheckRequest,
} from './pdf-spellcheck-contract.mjs';

const MAX_PAGES = 1_000;
const MAX_FINDINGS = 10_000;
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(message = 'PDF spellcheck report is invalid.') {
  const error = new Error(message);
  error.code = 'PDF_SPELLCHECK_OUTPUT_INVALID';
  return error;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeExtractedText(value) {
  return typeof value === 'string' && value.normalize('NFC') === value
    && [...value].every((point) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point)
      || '\t\n\f'.includes(point));
}

function plain(value, label) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalid(`${label} must be a plain object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true)) throw invalid(`${label} contains accessors.`);
    return descriptors;
  } catch (error) {
    if (error?.code === 'PDF_SPELLCHECK_OUTPUT_INVALID') throw error;
    throw invalid();
  }
}

function sourceRecords(value) {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_PAGES) {
      throw invalid('Spellcheck source pages are invalid.');
    }
    const output = [];
    let previous = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw invalid('Spellcheck source pages must be dense data.');
      }
      const fields = plain(descriptor.value, 'Spellcheck source page');
      if (Reflect.ownKeys(fields).length !== 2 || !Object.hasOwn(fields, 'page')
        || !Object.hasOwn(fields, 'text')) throw invalid('Spellcheck source page shape is invalid.');
      const page = fields.page.value;
      const text = fields.text.value;
      if (!Number.isSafeInteger(page) || page < 1 || page <= previous
        || !safeExtractedText(text)) {
        throw invalid('Spellcheck source page values are invalid.');
      }
      previous = page;
      output.push(Object.freeze({ page, text }));
    }
    return Object.freeze(output);
  } catch (error) {
    if (error?.code === 'PDF_SPELLCHECK_OUTPUT_INVALID') throw error;
    throw invalid();
  }
}

function validateReportPages(value) {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_PAGES) {
      throw invalid('Spellcheck report pages are invalid.');
    }
    const output = [];
    let previous = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw invalid('Spellcheck report pages must be dense data.');
      }
      const fields = plain(descriptor.value, 'Spellcheck page');
      if (Reflect.ownKeys(fields).length !== 3 || !Object.hasOwn(fields, 'page')
        || !Object.hasOwn(fields, 'tokenCount') || !Object.hasOwn(fields, 'findings')) {
        throw invalid('Spellcheck page shape is invalid.');
      }
      const page = fields.page.value;
      const tokenCount = fields.tokenCount.value;
      if (!Number.isSafeInteger(page) || page < 1 || page <= previous
        || !Number.isSafeInteger(tokenCount) || tokenCount < 0) {
        throw invalid('Spellcheck page counts are invalid.');
      }
      const findingList = fields.findings.value;
      if (!Array.isArray(findingList) || nodeTypes.isProxy(findingList)
        || Object.getPrototypeOf(findingList) !== Array.prototype
        || findingList.length > MAX_FINDINGS) throw invalid('Spellcheck findings are invalid.');
      const findings = [];
      for (let findingIndex = 0; findingIndex < findingList.length; findingIndex += 1) {
        const findingDescriptor = Object.getOwnPropertyDescriptor(findingList, String(findingIndex));
        if (!findingDescriptor || !Object.hasOwn(findingDescriptor, 'value')
          || findingDescriptor.enumerable !== true) throw invalid('Spellcheck findings must be dense data.');
        const findingFields = plain(findingDescriptor.value, 'Spellcheck finding');
        const expected = ['offset', 'tokenSha256', 'tokenLength', 'reason'];
        if (Reflect.ownKeys(findingFields).length !== expected.length
          || expected.some((key) => !Object.hasOwn(findingFields, key))) {
          throw invalid('Spellcheck finding shape is invalid.');
        }
        const offset = findingFields.offset.value;
        const tokenSha256 = findingFields.tokenSha256.value;
        const tokenLength = findingFields.tokenLength.value;
        const reason = findingFields.reason.value;
        if (!Number.isSafeInteger(offset) || offset < 0 || !SHA256.test(tokenSha256)
          || !Number.isSafeInteger(tokenLength) || tokenLength < 1 || reason !== 'dictionary-miss') {
          throw invalid('Spellcheck finding values are invalid.');
        }
        findings.push(Object.freeze({ offset, tokenSha256, tokenLength, reason }));
      }
      previous = page;
      output.push(Object.freeze({ page, tokenCount, findings: Object.freeze(findings) }));
    }
    return Object.freeze(output);
  } catch (error) {
    if (error?.code === 'PDF_SPELLCHECK_OUTPUT_INVALID') throw error;
    throw invalid();
  }
}

export function buildPdfSpellcheckReport({ request: requestValue, pages: pageValue } = {}) {
  const request = normalizePdfSpellcheckRequest(requestValue);
  const sourcePages = sourceRecords(pageValue);
  const dictionary = new Set(request.dictionary);
  const selected = request.pages ? new Set(request.pages) : null;
  const reportPages = [];
  let totalTokens = 0;
  let totalFindings = 0;
  let omittedFindings = 0;
  for (const sourcePage of sourcePages) {
    if (selected && !selected.has(sourcePage.page)) continue;
    const findings = [];
    let tokenCount = 0;
    WORD.lastIndex = 0;
    let match;
    while ((match = WORD.exec(sourcePage.text)) !== null) {
      tokenCount += 1;
      totalTokens += 1;
      const folded = match[0].toLocaleLowerCase('und');
      if (!dictionary.has(folded)) {
        if (totalFindings < MAX_FINDINGS) {
          findings.push(Object.freeze({
            offset: match.index,
            tokenSha256: digest(match[0]),
            tokenLength: [...match[0]].length,
            reason: 'dictionary-miss',
          }));
          totalFindings += 1;
        } else {
          omittedFindings += 1;
        }
      }
    }
    reportPages.push(Object.freeze({
      page: sourcePage.page,
      tokenCount,
      findings: Object.freeze(findings),
    }));
  }
  return Object.freeze({
    profile: PDF_SPELLCHECK_PROFILE,
    sourceSha256: request.sourceSha256,
    dictionaryDigest: digest(request.dictionary.join('\n')),
    pages: Object.freeze(reportPages),
    totalTokens,
    totalFindings,
    truncated: omittedFindings > 0,
    authority: 'extracted-text-review-only-v1',
    linguisticCorrectnessClaim: false,
    contentChanged: false,
  });
}

export function snapshotPdfSpellcheckReport(value) {
  const fields = plain(value, 'Spellcheck report');
  const expected = ['profile', 'sourceSha256', 'dictionaryDigest', 'pages', 'totalTokens',
    'totalFindings', 'truncated', 'authority', 'linguisticCorrectnessClaim', 'contentChanged'];
  if (Reflect.ownKeys(fields).length !== expected.length
    || expected.some((key) => !Object.hasOwn(fields, key))) throw invalid('Spellcheck report shape is invalid.');
  const report = {
    profile: fields.profile.value,
    sourceSha256: fields.sourceSha256.value,
    dictionaryDigest: fields.dictionaryDigest.value,
    pages: validateReportPages(fields.pages.value),
    totalTokens: fields.totalTokens.value,
    totalFindings: fields.totalFindings.value,
    truncated: fields.truncated.value,
    authority: fields.authority.value,
    linguisticCorrectnessClaim: fields.linguisticCorrectnessClaim.value,
    contentChanged: fields.contentChanged.value,
  };
  if (report.profile !== PDF_SPELLCHECK_PROFILE || !SHA256.test(report.sourceSha256)
    || !SHA256.test(report.dictionaryDigest) || !Number.isSafeInteger(report.totalTokens)
    || report.totalTokens < 0 || !Number.isSafeInteger(report.totalFindings)
    || report.totalFindings < 0 || typeof report.truncated !== 'boolean'
    || report.authority !== 'extracted-text-review-only-v1'
    || report.linguisticCorrectnessClaim !== false || report.contentChanged !== false) {
    throw invalid('Spellcheck report values are invalid.');
  }
  return Object.freeze(report);
}
