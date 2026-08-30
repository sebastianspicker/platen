import { createHash } from 'node:crypto';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../pdf/pdf-tagged-remediation-contract.mjs';
import {
  inspectTaggedPdfRemediation, writeTaggedPdfRemediation,
} from '../pdf/pdf-tagged-remediation-writer.mjs';
import { result, fail, requireString, sha256 } from './support.mjs';
import { explicitRepairInput } from './accessibility-ops-core.mjs';
import { passiveStructurePdf } from './accessibility-ops-heading-list.mjs';

export { accessibilityHeadingListStructure } from './accessibility-ops-heading-list.mjs';

export function accessibilityReadingOrder(ctx = {}) {
  const text = requireString(ctx.text ?? 'First block.\nSecond block.\nThird block.', 'text');
  const lines = text.split(/\n+/).filter(Boolean).slice(0, 100);
  const order = lines.map((line, i) => {
    const role = i === 0 && /^#{1,6}\s|^(chapter|section|part)\b/i.test(line) ? 'H1'
      : /^\s*[-*•]\s/.test(line) ? 'LBody'
        : /^\d+[\.)]\s/.test(line) ? 'LBody'
          : line.length < 48 && /^[A-Z]/.test(line) && !/[.!?]$/.test(line) ? 'H2'
            : 'P';
    return Object.freeze({
      index: i + 1,
      order: i + 1,
      role,
      text: line.slice(0, 200),
      page: 1,
    });
  });
  const orderSha256 = createHash('sha256')
    .update(order.map((o) => `${o.order}:${o.role}:${o.text}`).join('\n'))
    .digest('hex');
  if (order.length < 1) fail('INVALID_READING_ORDER', 'At least one ordered content item is required.', 400);
  let contentIndex = 0;
  const children = order.map((item) => {
    const index = item.index;
    if (item.role !== 'LBody') {
      return { id: `order-${index}`, role: item.role, page: 1, contentIndex: contentIndex++ };
    }
    return {
      id: `order-list-${index}`,
      role: 'L',
      children: [{
        id: `order-list-item-${index}`,
        role: 'LI',
        children: [{ id: `order-list-body-${index}`, role: 'LBody', page: 1, contentIndex: contentIndex++ }],
      }],
    };
  });
  const repair = explicitRepairInput(ctx, 'taggedRequest', () => {
    const source = passiveStructurePdf(order.length);
    return {
      source,
      request: {
        profile: TAGGED_PDF_REMEDIATION_PROFILE,
        sourceSha256: sha256(source),
        plan: { id: 'document', role: 'Document', children },
        language: 'en-US',
        title: 'Reading order',
        roleMap: {},
      },
    };
  });
  const { source, request } = repair;
  const written = writeTaggedPdfRemediation(source, request);
  const proof = inspectTaggedPdfRemediation(source, written.bytes, request);
  const pdf = written.bytes;
  return result('accessibility.reading-order', {
    method: 'local-tagged-reading-order-apply',
    order: Object.freeze(order),
    count: order.length,
    orderSha256,
    applied: true,
    structureLinked: proof.structureLinked,
    proof,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
    sourceSha256: sha256(source),
    demoFixtureUsed: repair.demoFixtureUsed,
    sourceByteLength: source.length,
    repairRequest: request,
  });
}
