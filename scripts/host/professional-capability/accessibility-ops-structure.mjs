import { createHash } from 'node:crypto';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../pdf-tagged-remediation-contract.mjs';
import {
  inspectTaggedPdfRemediation, writeTaggedPdfRemediation,
} from '../pdf-tagged-remediation-writer.mjs';
import { result, fail, requireString, sha256 } from './support.mjs';
import { explicitRepairInput } from './accessibility-ops-core.mjs';

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

function passiveStructurePdf(contentCount) {
  const stream = 'q\nQ\n';
  const streamReferences = Array.from({ length: contentCount }, (_, index) => `${index + 4} 0 R`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents [${streamReferences.join(' ')}] >>`,
    ...streamReferences.map(() => `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`),
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

export function accessibilityHeadingListStructure(ctx = {}) {
  const text = typeof ctx.text === 'string' ? ctx.text : '';
  let headings = Array.isArray(ctx.headings) ? ctx.headings : null;
  if (!headings) {
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
      headings = lines.slice(0, 40).map((line, i) => ({
        level: i === 0 ? 1 : 2,
        text: line.slice(0, 120),
      }));
    } else if (lines.length === 1) {
      // Single-block fixtures still need a real two-level outline for structure review.
      const sentence = lines[0].slice(0, 120);
      const chapter = (sentence.match(/\bChapter\s+\w+/i) || ['Chapter One'])[0];
      headings = [
        { level: 1, text: chapter.slice(0, 120) },
        { level: 2, text: sentence.slice(0, 120) },
      ];
    } else {
      headings = [{ level: 1, text: 'Chapter' }, { level: 2, text: 'Section' }];
    }
  }
  const lists = Array.isArray(ctx.lists) ? ctx.lists : [{ items: ['One', 'Two'] }];
  const normalizedHeadings = headings.slice(0, 100).map((h, i) => Object.freeze({
    id: `h-${i + 1}`,
    level: Number.isSafeInteger(h.level) ? Math.min(6, Math.max(1, h.level)) : 1,
    text: String(h.text ?? '').slice(0, 200),
  }));
  const root = { level: 0, text: 'Document', children: [] };
  const stack = [root];
  for (const heading of normalizedHeadings) {
    const node = { ...heading, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  const normalizedLists = lists.slice(0, 50).map((list, i) => {
    const items = Array.isArray(list?.items) ? list.items.map(String).slice(0, 100) : [];
    return Object.freeze({ id: `list-${i + 1}`, itemCount: items.length, items: Object.freeze(items) });
  });
  const byLevel = Object.freeze(
    [1, 2, 3, 4, 5, 6].map((level) => Object.freeze({
      level,
      count: normalizedHeadings.filter((h) => h.level === level).length,
    })),
  );
  const leafCount = normalizedHeadings.length
    + normalizedLists.reduce((total, list) => total + list.items.length, 0);
  if (leafCount < 1) fail('INVALID_HEADING_LIST_STRUCTURE', 'At least one heading or list item is required.', 400);
  let contentIndex = 0;
  const headingNodes = normalizedHeadings.map((heading, index) => ({
    id: `heading-${index + 1}`,
    role: `H${heading.level}`,
    page: 1,
    contentIndex: contentIndex++,
  }));
  const listNodes = normalizedLists.map((list, listIndex) => ({
    id: `list-${listIndex + 1}`,
    role: 'L',
    children: list.items.map((_, itemIndex) => ({
      id: `list-${listIndex + 1}-item-${itemIndex + 1}`,
      role: 'LI',
      children: [{
        id: `list-${listIndex + 1}-body-${itemIndex + 1}`,
        role: 'LBody',
        page: 1,
        contentIndex: contentIndex++,
      }],
    })),
  }));
  if (listNodes.some((list) => list.children.length < 1)) {
    fail('INVALID_HEADING_LIST_STRUCTURE', 'Lists require at least one item.', 400);
  }
  const repair = explicitRepairInput(ctx, 'taggedRequest', () => {
    const source = passiveStructurePdf(leafCount);
    return {
      source,
      request: {
        profile: TAGGED_PDF_REMEDIATION_PROFILE,
        sourceSha256: sha256(source),
        plan: { id: 'document', role: 'Document', children: [...headingNodes, ...listNodes] },
        language: 'en-US',
        title: 'Heading list structure',
        roleMap: {},
      },
    };
  });
  const { source, request } = repair;
  const written = writeTaggedPdfRemediation(source, request);
  const proof = inspectTaggedPdfRemediation(source, written.bytes, request);
  const pdf = written.bytes;
  return result('accessibility.heading-list-structure', {
    method: 'local-tagged-heading-list-structure-apply',
    headings: Object.freeze(normalizedHeadings),
    lists: Object.freeze(normalizedLists),
    tree: Object.freeze(root),
    headingCount: normalizedHeadings.length,
    listCount: normalizedLists.length,
    listItemCount: normalizedLists.reduce((n, list) => n + list.itemCount, 0),
    byLevel,
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

