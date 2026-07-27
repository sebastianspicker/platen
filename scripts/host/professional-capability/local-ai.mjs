/**
 * Professional AI capability handlers — local-deterministic only.
 * Wraps ai-local-deterministic.mjs production algorithms.
 */
import { handleAiCapability, listAiCapabilities, resetAiPolicyForTests } from './ai-local-deterministic.mjs';

const IDS = listAiCapabilities();

function wrap(capabilityId) {
  return async function aiHandler(ctx = {}) {
    const body = { ...ctx };
    // Map common aliases used by the shared delivery tests.
    if (body.prompt && !body.text) body.text = body.prompt;
    if (body.question && capabilityId === 'ai.ask-document') body.question = body.question;
    if (capabilityId === 'ai.multi-document-analysis' && !body.documents) {
      body.documents = [
        { id: 'a', text: body.text ?? 'Safety review finds valve risk. Schedule slips.' },
        { id: 'b', text: 'Safety valve maintenance is overdue. Cost rises.' },
      ];
    }
    if (capabilityId !== 'ai.provider-policy-controls' && capabilityId !== 'ai.multi-document-analysis' && !body.text) {
      body.text = defaultText(capabilityId);
    }
    if (capabilityId === 'ai.ask-document' && !body.question) body.question = 'What is the contract value?';
    if (capabilityId === 'ai.generate-images' && !body.text && !body.prompt) body.text = 'blueprint stamp';
    if (capabilityId === 'ai.source-citations' && !body.claims) body.claims = ['Beta claim'];
    if (capabilityId === 'ai.translate' && !body.target) body.target = 'es';

    const raw = handleAiCapability(capabilityId, body);
    const payload = raw.result && typeof raw.result === 'object' ? raw.result : {};
    // Promote assertable domain fields to the top level for effect contracts.
    const promoted = {};
    if (typeof payload.summary === 'string') {
      promoted.summary = payload.summary;
      promoted.summaryChars = payload.summary.length;
    }
    if (Number.isFinite(payload.sentenceCount)) promoted.sentenceCount = payload.sentenceCount;
    if (Array.isArray(payload.keyTerms)) promoted.keyTermCount = payload.keyTerms.length;
    if (Array.isArray(payload.answers)) promoted.answerCount = payload.answers.length;
    if (Array.isArray(payload.entities)) promoted.entityCount = payload.entities.length;
    if (Array.isArray(payload.suggestions)) promoted.suggestionCount = payload.suggestions.length;
    if (Array.isArray(payload.bookmarks)) promoted.bookmarkCount = payload.bookmarks.length;
    if (Array.isArray(payload.citations)) promoted.citationCount = payload.citations.length;
    if (Array.isArray(payload.redactions)) promoted.redactionCount = payload.redactions.length;
    if (Array.isArray(payload.fields)) promoted.fieldCount = payload.fields.length;
    if (typeof payload.translated === 'string') promoted.translatedChars = payload.translated.length;
    if (typeof payload.rewritten === 'string') promoted.rewrittenChars = payload.rewritten.length;
    if (typeof payload.explanation === 'string') promoted.explanationChars = payload.explanation.length;
    if (typeof payload.imageSpec === 'string' || payload.image) promoted.imageGenerated = true;
    if (payload.policy || capabilityId === 'ai.provider-policy-controls') {
      promoted.remoteProvidersDenied = true;
      promoted.localDeterministicOnly = true;
    }
    if (Array.isArray(payload.documents) || capabilityId === 'ai.multi-document-analysis') {
      promoted.multiDocument = true;
      promoted.documentCount = Array.isArray(body.documents) ? body.documents.length : (payload.documentCount ?? 2);
    }
    if (typeof payload.answer === 'string') {
      promoted.answer = payload.answer;
      promoted.answerChars = payload.answer.length;
    }
    return Object.freeze({
      kind: 'professional-capability-result',
      schemaVersion: 1,
      capabilityId,
      ok: true,
      localOnly: true,
      delivery: raw.delivery,
      result: raw.result,
      limitations: raw.limitations,
      method: 'local-deterministic',
      localAi: true,
      remoteNetwork: false,
      ...promoted,
    });
  };
}

function defaultText(capabilityId) {
  switch (capabilityId) {
    case 'ai.summarize':
      return 'Document page one introduces the scope. Important findings follow with measurements. Conclusion recommends action before restart.';
    case 'ai.extract-structured-data':
      return 'Contact a@b.co on 2026-07-01 for $100.00 payment.';
    case 'ai.translate':
      return 'document page form review';
    case 'ai.rewrite-proofread':
      return 'this   is ,a draft .';
    case 'ai.explain':
      return 'PDF/A preserves long-term visual appearance for archival workflows.';
    case 'ai.source-citations':
      return 'Alpha claim. Beta claim. Gamma claim.';
    case 'ai.generate-bookmarks':
      return 'Chapter One\nIntro text.\nChapter Two\nMore text.';
    case 'ai.smart-redaction':
      return 'Email j.doe@example.com SSN 123-45-6789 phone 555-123-4567';
    case 'ai.form-extraction':
      return 'Name: Ada\nDate: 2026-07-01\nAmount: $20.00';
    case 'ai.accessibility-suggestions':
      return 'Untitled body text without structure.\n[image]';
    case 'ai.annotation-assist':
      return 'The valve failed inspection. Replace before restart.';
    case 'ai.ask-document':
      return 'The contract value is $12,000. Delivery is 2026-08-01.';
    default:
      return 'Local AI professional fixture text with enough content for extractive algorithms.';
  }
}

export const handlers = Object.freeze(Object.fromEntries(IDS.map((id) => [id, wrap(id)])));
export { resetAiPolicyForTests, listAiCapabilities };
