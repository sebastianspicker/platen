import { attachmentRemovalResult, javascriptRemovalResult } from '../editor-result-views.js';
import { property } from './document-panel.js';

export function activeContentSections(state, readiness, analysis) {
  const javascript = String(analysis.inspection?.javascript ?? 'unknown').toLowerCase();
  const attachments = Array.isArray(analysis.attachments) ? analysis.attachments : [];
  return `<section class="property-section">
        <h3>Document JavaScript</h3>
        ${property('Poppler evidence', javascript)}
        <button class="button danger-button" data-action="remove-document-javascript" ${readiness.javascriptRemovalReady ? '' : 'disabled'}>Create JavaScript-removed copy</button>
        <p class="field-help">The fixed cross-platform profile removes exactly one indirect Catalog <code>/OpenAction</code> script or one flat Catalog <code>/Names /JavaScript</code> entry. Button availability is only a coarse candidate check from public inspection; the host reparses the raw object graph and may reject it. The operation first proves logical deletion, then emits a fresh closed classic revision so the admitted script and prior revisions are not retained in the derived copy. It rejects additional or vendor actions, forms, signatures, attachments, XMP, tags, layers, shared targets, script streams, compressed targets, and unsupported graphs. This is not general hidden-data sanitization, arbitrary action editing, or byte/object/signature preservation.</p>
        ${javascript === 'yes' && !readiness.javascriptRemovalReady ? '<p class="field-help">JavaScript was reported, but this source is not currently eligible for the strict one-locus removal profile.</p>' : ''}
        ${javascriptRemovalResult(state)}
      </section>
      <section class="property-section">
        <h3>Embedded attachment removal</h3>
        ${property('Poppler inventory', attachments.length === 1 ? 'one attachment' : `${attachments.length} attachments`)}
        <button class="button danger-button" data-action="remove-document-attachment" ${readiness.attachmentRemovalReady ? '' : 'disabled'}>Create attachment-removed copy</button>
        <p class="field-help">The fixed cross-platform profile accepts only one exact flat document-level attachment in a passive classic-xref source. The host privately extracts and digest-binds its name and bytes, proves logical deletion of the name tree, Filespec, and embedded stream, then emits and reparses a fresh closed classic revision. Public receipts contain only name and content digests plus byte count. Shared targets, actions, forms, signatures, XMP, tags, layers, presentation automation, alternate attachment loci, and unsupported graphs fail closed. This is removal only, not attachment addition, extraction, rename, multi-attachment management, or general hidden-data sanitization.</p>
        ${attachments.length === 1 && !readiness.attachmentRemovalReady ? '<p class="field-help">One attachment was reported, but this source is not currently eligible for the strict one-locus removal profile.</p>' : ''}
        ${attachmentRemovalResult(state)}
      </section>`;
}
