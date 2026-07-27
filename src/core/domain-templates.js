const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function withRevision(revision, value = {}) {
  return { ...value, options: { expectedRevision: revision } };
}

const readOnly = new Set([
  'review.exportReviewJson', 'review.reviewSummary', 'forms.validate', 'forms.exportForms',
  'AEC.snapshot', 'AEC.legends',
]);

export function domainPayloadValue(group, operation, { revision = 0, documentDigest = DIGEST_A } = {}) {
  const key = `${group}.${operation}`;
  if (readOnly.has(key)) return {};
  const templates = {
    'review.createAnnotation': { input: { type: 'comment', page: 1, rectangle: [36, 36, 180, 80], text: 'Review note', author: 'Local reviewer', mentions: [] } },
    'review.reply': { annotationId: 'annotation-1', input: { text: 'Local reply', author: 'Local reviewer' } },
    'review.updateAnnotation': { annotationId: 'annotation-1', patch: { status: 'inProgress', text: 'Updated review note' } },
    'review.setReviewState': { input: { participants: ['Local reviewer'], dueDate: '2099-12-31', tracking: 'Local review round' } },
    'review.queryAnnotations': { query: { search: '', groupBy: 'none', sortBy: 'createdAt', direction: 'asc' } },
    'review.importReviewJson': { interchange: { format: 'platen-review-v1', annotations: [] } },
    'forms.createField': { input: { id: 'field-1', name: 'full_name', type: 'text', page: 1, rectangle: [36, 700, 280, 722], tabOrder: 1, tooltip: 'Full name', required: true, defaultValue: '', options: [], validation: { pattern: '' } } },
    'forms.setValue': { fieldId: 'field-1', value: 'Local value' },
    'forms.resetValues': {},
    'forms.submitResponse': {},
    'forms.importForms': { input: { format: 'platen-forms-v1', fields: [], values: [] } },
    'forms.detectFields': { text: 'Full Name*\nOrder Amount\nI agree', options: { page: 1 } },
    'forms.staticToFillable': { definitions: [{ id: 'field-1', name: 'full_name', type: 'text', page: 1, rectangle: [36, 700, 280, 722], tooltip: 'Full name', required: false, defaultValue: '', options: [], validation: { pattern: '' } }] },
    'AEC.createToolset': { input: { name: 'Local QA', tools: ['cloud', 'arrow'] } },
    'AEC.createMarkup': { input: { type: 'issue', page: 1, status: 'open', properties: {} } },
    'AEC.listMarkups': { query: { status: 'open' } },
    'AEC.createCustomColumn': { input: { name: 'Total', formula: 'length * width + 2' } },
    'AEC.evaluateCustomColumn': { columnId: 'column-1', values: { length: 3, width: 4 } },
    'AEC.createSpace': { input: { name: 'Room 1', kind: 'space', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] } },
    'AEC.createDrawingSet': { input: { name: 'Issued set', sheets: ['sheet-1'] } },
    'AEC.createSheet': { input: { number: 'A101', title: 'Plan', tags: ['local'] } },
    'AEC.createRevisionOverlay': { input: { fromDigest: DIGEST_A, toDigest: DIGEST_B, sheetId: 'sheet-1' } },
    'AEC.createBatchPlan': { input: { kind: 'slip-sheet', pairs: [{ from: 'sheet-old', to: 'sheet-new' }] } },
    'AEC.calibrateGeoPage': { input: { page: 1, origin: { x: 10, y: 20 }, scale: 2, rotation: 0 } },
    'AEC.pageToGeo': { calibrationId: 'geo-1', pagePoint: { x: 3, y: 4 } },
    'AEC.takeoff': { input: { measurementIds: ['measurement-1'], group: 'default' } },
    'collaboration.createProject': { input: { name: 'Local project', offline: true } },
    'collaboration.createRevision': { input: { label: 'R1' } },
    'collaboration.transitionRevision': { revisionId: 'revision-1', nextStatus: 'issued' },
    'collaboration.createWorkspace': { input: { name: 'Local workspace' } },
    'collaboration.createReviewSession': { input: { workspaceId: 'workspace-1', participants: [] } },
    'collaboration.recordParticipant': { input: { name: 'Local reviewer', role: 'reviewer' } },
    'collaboration.recordActivity': { input: { kind: 'opened', subjectId: 'review-1' } },
    'collaboration.createNotification': { input: { recipientId: 'participant-1', message: 'Review ready locally' } },
    'collaboration.createSharePackage': { input: { documentDigest, expiresAt: '2099-12-31T23:59:59.000Z' } },
    'collaboration.recordVersion': { input: { documentDigest, parentDigest: null } },
    'collaboration.createRepositoryConnector': { input: { name: 'Descriptor only', kind: 'local-descriptor' } },
    'collaboration.createRetentionRule': { input: { name: 'Seven years', days: 2555 } },
    'collaboration.checkout': { input: { documentDigest, ownerId: 'participant-1' } },
    'collaboration.checkin': { lockId: 'lock-1', ownerId: 'participant-1' },
    'collaboration.appendSyncJournal': { input: { operation: 'merge', conflict: false, resolution: 'manual-review' } },
    'redaction.detectSensitiveText': { pages: [{ pageNumber: 1, text: 'Contact local@example.test' }], options: { customPatterns: [] } },
    'redaction.createRedactionPlan': { input: { pages: [{ pageNumber: 1, text: 'Contact local@example.test' }], customPatterns: [], rectangles: [], fullPages: [] } },
    'accessibility.inspect': { summary: { tagged: false, title: '', language: '', unicodeMapped: true, fontsEmbedded: true, pages: [], images: [], forms: [], readingOrderIssues: [] } },
    'accessibility.exportReport': { report: { status: 'inspection-only', issues: [], summary: { issueCount: 0, conformsPdfUa: false } }, format: 'json' },
    'accessibility.proposeRemediation': { summary: { tagged: false, title: '', language: '', unicodeMapped: true, fontsEmbedded: true, pages: [], images: [], forms: [], readingOrderIssues: [], proposedTagTree: [], readingOrder: [] } },
    'signing.createElectronicIntent': { input: { documentDigest, intent: { action: 'approve', signer: 'local-signer' }, consent: { accepted: true }, route: [{ recipient: 'local-signer' }], appearance: { pageNumber: 1, label: 'Approved locally' } } },
    'signing.verifyLocalIntent': { input: { documentDigest, intent: { action: 'approve', signer: 'local-signer' } } },
  };
  const template = structuredClone(templates[key] ?? {});
  const mutating = ![
    'review.queryAnnotations', 'forms.detectFields', 'AEC.listMarkups', 'AEC.evaluateCustomColumn',
    'AEC.pageToGeo', 'redaction.detectSensitiveText', 'accessibility.inspect',
    'accessibility.exportReport', 'signing.verifyLocalIntent',
  ].includes(key);
  return mutating ? withRevision(revision, template) : template;
}

export function domainPayloadTemplate(group, operation, options) {
  return JSON.stringify(domainPayloadValue(group, operation, options), null, 2);
}
