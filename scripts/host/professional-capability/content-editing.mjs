import { result, requireString } from './support.mjs';
import { opEditText } from './real-ops.mjs';
import { editableTextPdf } from './fixtures.mjs';
import { createHash } from 'node:crypto';
import { buildPdfSpellcheckReport } from '../pdf-spellcheck-report.mjs';
import { PDF_SPELLCHECK_PROFILE } from '../pdf-spellcheck-contract.mjs';
import {
  localEditLinks,
  productionEditLinks,
} from './content-editing-links-production.mjs';
import {
  documentMetadataEdit,
  documentFlattenContent,
} from './content-editing-document.mjs';
import { executeDocumentActionsJavascript } from './document-actions-javascript.mjs';
import { editHeadersFooters } from './edit-headers-footers.mjs';

const FAMILY = 'content-editing';

export const handlers = Object.freeze({
  async 'edit.text'(ctx = {}) { return opEditText({ ...ctx, capabilityId: 'edit.text' }); },

  async 'edit.links'(ctx = {}) {
    if (ctx.documentId || ctx.incrementalGoToLink || ctx.readArtifact) {
      return productionEditLinks(ctx);
    }
    return localEditLinks(ctx);
  },

  async 'edit.headers-footers'(ctx = {}) { return editHeadersFooters(ctx); },

  async 'edit.find-replace'(ctx = {}) {
    const edited = await opEditText({ ...ctx, capabilityId: 'edit.find-replace' });
    return result('edit.find-replace', { ...edited, capabilityId: 'edit.find-replace' });
  },

  async 'edit.spellcheck'(ctx = {}) {
    const text = requireString(ctx.text ?? 'Hello wrld text', 'text');
    const dictionary = Array.isArray(ctx.dictionary) && ctx.dictionary.length
      ? ctx.dictionary.map(String)
      : ['Hello', 'world', 'text', 'is', 'the', 'and', 'a'];
    const sourceSha256 = createHash('sha256').update(text).digest('hex');
    const report = buildPdfSpellcheckReport({
      request: {
        profile: PDF_SPELLCHECK_PROFILE,
        sourceSha256,
        dictionary,
        pages: null,
      },
      pages: [{ page: 1, text }],
    });
    if (!Number.isSafeInteger(report.totalFindings) || report.contentChanged !== false) {
      fail('SPELLCHECK_INVALID', 'Spellcheck report invalid.', 502);
    }
    return result('edit.spellcheck', {
      familyId: FAMILY,
      method: 'local-pdf-spellcheck-report',
      report,
      totalFindings: report.totalFindings,
      totalTokens: report.totalTokens,
      truncated: report.truncated,
      contentChanged: false,
      sourceSha256,
    });
  },

  async 'document.metadata-edit'(ctx = {}) { return documentMetadataEdit(ctx); },
  async 'document.flatten-content'(ctx = {}) { return documentFlattenContent(ctx); },
  async 'document.actions-javascript'(ctx = {}) { return executeDocumentActionsJavascript(ctx); },
});
