import { HostError } from './host-error.mjs';
import { ReviewFormsDomain } from './domains/review-forms.mjs';
import { AccessibilityDomainService } from './domains/accessibility-domain.mjs';
import { AecDomain } from './domains/aec-domain.mjs';
import { CollaborationDomain } from './domains/collaboration-domain.mjs';
import { RedactionDomainService } from './domains/redaction-domain.mjs';
import { SigningDomainService } from './domains/signing-domain.mjs';

const MAX_DEPTH = 8;
const MAX_ARRAY = 1_000;
const MAX_KEYS = 100;
const MAX_STRING = 10_000;
const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/i;

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_DOMAIN_REQUEST', `${label} must be a JSON object.`);
  }
  return value;
}
function jsonSafe(value, depth = 0) {
  if (depth > MAX_DEPTH) fail('INVALID_DOMAIN_BODY', 'Domain request body is too deeply nested.', 413);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_DOMAIN_BODY', 'Domain request body must contain finite JSON numbers.');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) fail('INVALID_DOMAIN_BODY', 'Domain request body contains an overlong string.', 413);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) fail('INVALID_DOMAIN_BODY', 'Domain request body contains an oversized array.', 413);
    for (const item of value) jsonSafe(item, depth + 1);
    return;
  }
  plainObject(value, 'Domain request body');
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) fail('INVALID_DOMAIN_BODY', 'Domain request body contains too many keys.', 413);
  for (const [key, item] of entries) {
    if (UNSAFE_KEY.test(key)) fail('INVALID_DOMAIN_BODY', 'Domain request body contains a prohibited key.');
    jsonSafe(item, depth + 1);
  }
}

function operation(semantics, invoke) { return Object.freeze({ supported: true, semantics, invoke }); }
function unsupported(semantics) { return Object.freeze({ supported: false, semantics }); }

// This is intentionally data-driven: callers can only reach entries declared here.
const REGISTRY = Object.freeze({
  review: Object.freeze({
    createAnnotation: operation('Create a session-only review annotation.', (d, id, b) => d.createAnnotation(id, b.input, b.options)),
    reply: operation('Add a reply to a session-only annotation.', (d, id, b) => d.reply(id, b.annotationId, b.input, b.options)),
    updateAnnotation: operation('Update a session-only annotation.', (d, id, b) => d.updateAnnotation(id, b.annotationId, b.patch, b.options)),
    setReviewState: operation('Set review participants, due date, and tracking state.', (d, id, b) => d.setReviewState(id, b.input, b.options)),
    queryAnnotations: operation('Query sidecar annotations without changing PDF bytes.', (d, id, b) => d.queryAnnotations(id, b.query)),
    exportReviewJson: operation('Export the bounded review sidecar interchange.', (d, id) => d.exportReviewJson(id)),
    importReviewJson: operation('Import bounded review sidecar interchange.', (d, id, b) => d.importReviewJson(id, b.interchange, b.options)),
    reviewSummary: operation('Create CSV/XFDF summary data; does not embed annotations.', (d, id) => d.reviewSummary(id)),
  }),
  forms: Object.freeze({
    createField: operation('Create a session-only form field.', (d, id, b) => d.createField(id, b.input, b.options)),
    setValue: operation('Set a bounded form value and evaluate safe calculations.', (d, id, b) => d.setValue(id, b.fieldId, b.value, b.options)),
    resetValues: operation('Reset form values to defaults.', (d, id, b) => d.resetValues(id, b.options)),
    validate: operation('Validate session-only form values.', (d, id) => d.validate(id)),
    submitResponse: operation('Store a validated session-only response.', (d, id, b) => d.submitResponse(id, b.options)),
    exportForms: operation('Export bounded forms interchange and CSV.', (d, id) => d.exportForms(id)),
    importForms: operation('Import bounded forms interchange.', (d, id, b) => d.importForms(id, b.input, b.options)),
    detectFields: operation('Deterministically detect candidate fields from supplied text.', (d, _id, b) => d.detectFields(b.text, b.options)),
    staticToFillable: operation('Create session-only fields from supplied definitions.', (d, id, b) => d.staticToFillable(id, b.definitions, b.options)),
    xfa: unsupported('XFA workflows are unsupported in this local prototype.'),
    flatten: unsupported('PDF flattening is irreversible and unsupported in this local prototype.'),
  }),
  AEC: Object.freeze({
    snapshot: operation('Read the current local AEC workspace snapshot.', (d, id) => d.snapshot(id)),
    createToolset: operation('Store a local markup toolset.', (d, id, b) => d.createToolset(id, b.input, b.options)),
    createMarkup: operation('Store a local AEC markup.', (d, id, b) => d.createMarkup(id, b.input, b.options)),
    listMarkups: operation('List local AEC markups.', (d, id, b) => d.listMarkups(id, b.query)),
    createCustomColumn: operation('Create a safe arithmetic custom column.', (d, id, b) => d.createCustomColumn(id, b.input, b.options)),
    evaluateCustomColumn: operation('Evaluate a safe arithmetic custom column.', (d, id, b) => d.evaluateCustomColumn(id, b.columnId, b.values)),
    createSpace: operation('Store a local spatial region.', (d, id, b) => d.createSpace(id, b.input, b.options)),
    createDrawingSet: operation('Store a local drawing set.', (d, id, b) => d.createDrawingSet(id, b.input, b.options)),
    createSheet: operation('Store a local sheet.', (d, id, b) => d.createSheet(id, b.input, b.options)),
    createRevisionOverlay: operation('Store a local revision overlay descriptor.', (d, id, b) => d.createRevisionOverlay(id, b.input, b.options)),
    createBatchPlan: operation('Store a local batch-plan descriptor.', (d, id, b) => d.createBatchPlan(id, b.input, b.options)),
    legends: operation('Count local markup types.', (d, id) => d.legends(id)),
    calibrateGeoPage: operation('Store a local geospatial calibration.', (d, id, b) => d.calibrateGeoPage(id, b.input, b.options)),
    pageToGeo: operation('Convert a point using a local geospatial calibration.', (d, id, b) => d.pageToGeo(id, b.calibrationId, b.pagePoint)),
    takeoff: operation('Store a local quantity takeoff.', (d, id, b) => d.takeoff(id, b.input, b.options)),
  }),
  collaboration: Object.freeze({
    createProject: operation('Create an offline-only local project.', (d, id, b) => d.createProject(id, b.input, b.options)),
    createRevision: operation('Create a local revision status.', (d, id, b) => d.createRevision(id, b.input, b.options)),
    transitionRevision: operation('Transition a local revision through allowed states.', (d, id, b) => d.transitionRevision(id, b.revisionId, b.nextStatus, b.options)),
    createWorkspace: operation('Create an offline-only local workspace.', (d, id, b) => d.createWorkspace(id, b.input, b.options)),
    createReviewSession: operation('Create a local review session.', (d, id, b) => d.createReviewSession(id, b.input, b.options)),
    recordParticipant: operation('Record a local participant.', (d, id, b) => d.recordParticipant(id, b.input, b.options)),
    recordActivity: operation('Record local review activity.', (d, id, b) => d.recordActivity(id, b.input, b.options)),
    createNotification: operation('Create a local-only notification record.', (d, id, b) => d.createNotification(id, b.input, b.options)),
    createSharePackage: operation('Create a local-only share package descriptor.', (d, id, b) => d.createSharePackage(id, b.input, b.options)),
    recordVersion: operation('Record local version history.', (d, id, b) => d.recordVersion(id, b.input, b.options)),
    createRepositoryConnector: operation('Create a non-authenticated connector descriptor.', (d, id, b) => d.createRepositoryConnector(id, b.input, b.options)),
    createRetentionRule: operation('Create a local retention rule.', (d, id, b) => d.createRetentionRule(id, b.input, b.options)),
    checkout: operation('Create or refresh a local document lock.', (d, id, b) => d.checkout(id, b.input, b.options)),
    checkin: operation('Release a local document lock.', (d, id, b) => d.checkin(id, b.lockId, b.ownerId, b.options)),
    appendSyncJournal: operation('Append a local-only sync journal entry.', (d, id, b) => d.appendSyncJournal(id, b.input, b.options)),
  }),
  redaction: Object.freeze({
    detectSensitiveText: operation('Detect candidate sensitive text; no PDF bytes are changed.', (d, _id, b) => d.detectSensitiveText(b.pages, b.options)),
    createRedactionPlan: operation('Store a proposed-not-applied local redaction plan.', (d, id, b) => d.createRedactionPlan(id, b.input, b.options)),
    apply: unsupported('Applying redactions is irreversible and requires a separate raster and semantic verifier.'),
  }),
  accessibility: Object.freeze({
    inspect: operation('Inspect supplied accessibility summary data.', (d, _id, b) => d.inspectAccessibility(b.summary)),
    exportReport: operation('Export a supplied accessibility report as JSON or CSV.', (d, _id, b) => d.exportAccessibilityReport(b.report, b.format)),
    proposeRemediation: operation('Store a proposed-not-applied accessibility remediation.', (d, id, b) => d.proposeAccessibilityRemediation(id, b.summary, b.options)),
  }),
  signing: Object.freeze({
    createElectronicIntent: operation('Create a local audit-chain signing intent without certificate claims.', (d, id, b) => d.createElectronicSigningIntent(id, b.input, b.options)),
    verifyLocalIntent: operation('Verify a local signing-intent audit chain.', (d, id, b) => d.verifyLocalSigningIntent(id, b.input)),
    certificateSigning: unsupported('Certificate signing is unsupported in this local prototype.'),
    certificateTrust: unsupported('Certificate trust is unsupported in this local prototype.'),
    certificateRevocation: unsupported('Certificate revocation is unsupported in this local prototype.'),
    certificateLtv: unsupported('Long-term certificate validation is unsupported in this local prototype.'),
    digitalId: unsupported('Digital-ID operations are unsupported in this local prototype.'),
  }),
});

function publicRegistry() {
  return Object.freeze(Object.fromEntries(Object.entries(REGISTRY).map(([group, operations]) => [group, Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, entry]) => [name, Object.freeze({ supported: entry.supported, semantics: entry.semantics })])))])));
}

export const DOMAIN_OPERATION_REGISTRY = publicRegistry();

/** Stable allowlisted facade over local prototype domain services. */
export class DomainFacade {
  #domains;

  constructor(workspaceStateStore, {
    reviewForms,
    aec,
    collaboration,
    redaction,
    accessibility,
    signing,
    domainOptions = {},
  } = {}) {
    if (!workspaceStateStore || typeof workspaceStateStore.snapshot !== 'function') throw new TypeError('DomainFacade requires WorkspaceStateStore.');
    this.#domains = Object.freeze({
      review: reviewForms ?? new ReviewFormsDomain(workspaceStateStore, domainOptions.reviewForms),
      forms: reviewForms ?? new ReviewFormsDomain(workspaceStateStore, domainOptions.reviewForms),
      AEC: aec ?? new AecDomain(workspaceStateStore, domainOptions.aec),
      collaboration: collaboration
        ?? new CollaborationDomain(workspaceStateStore, domainOptions.collaboration),
      redaction: redaction
        ?? new RedactionDomainService(workspaceStateStore, domainOptions.redaction),
      accessibility: accessibility
        ?? new AccessibilityDomainService(workspaceStateStore, domainOptions.accessibility),
      signing: signing
        ?? new SigningDomainService(workspaceStateStore, domainOptions.signing),
    });
  }

  listOperations() { return DOMAIN_OPERATION_REGISTRY; }

  execute(documentId, request) {
    plainObject(request, 'Domain request');
    const { group, operation: operationName, body = {} } = request;
    if (typeof group !== 'string' || !Object.hasOwn(REGISTRY, group)) fail('DOMAIN_GROUP_UNSUPPORTED', 'Unsupported domain operation group.', 404);
    if (typeof operationName !== 'string' || !Object.hasOwn(REGISTRY[group], operationName)) fail('DOMAIN_OPERATION_UNSUPPORTED', 'Unsupported domain operation.', 404);
    plainObject(body, 'Domain request body');
    jsonSafe(body);
    const entry = REGISTRY[group][operationName];
    if (!entry.supported) fail('DOMAIN_OPERATION_UNSUPPORTED', entry.semantics, 409);
    return clone(entry.invoke(this.#domains[group], documentId, clone(body)));
  }
}

export function createDomainFacade(workspaceStateStore, options) { return new DomainFacade(workspaceStateStore, options); }
