import {
  annotationTypes, isBoolean, isFiniteNumber, isFingerprint, isInteger, isNullableString,
  parsePdfkitEnvelope, responseError,
} from './response-common.mjs';

const widgetTypes = new Set(['text', 'button', 'choice', 'signature', 'unknown']);
const widgetControlKinds = new Set(['checkbox', 'radio', 'push', 'unknown']);
const linkTypes = new Set(['goTo', 'url', 'remoteGoTo', 'namedAction', 'namedDestination', 'unresolved']);

function validRectangle(value) {
  return value && Object.keys(value).length === 4 && ['x', 'y', 'width', 'height'].every(
    (key) => isFiniteNumber(value[key]),
  );
}

function validPage(value) {
  if (!value || Object.keys(value).length !== 10 || !isInteger(value.index, 1, 1_000_000)
    || typeof value.label !== 'string' || Buffer.byteLength(value.label, 'utf8') > 1_024
    || !isInteger(value.rotation, -360, 360) || !value.boxes || Object.keys(value.boxes).length !== 5
    || !['media', 'crop', 'bleed', 'trim', 'art'].every((key) => validRectangle(value.boxes[key]))
    || !Array.isArray(value.annotations) || !isBoolean(value.annotationsTruncated)
    || !Array.isArray(value.widgets) || !isBoolean(value.widgetsTruncated)
    || !Array.isArray(value.links) || !isBoolean(value.linksTruncated)) return false;
  const linkAnnotationIndexes = new Set(value.annotations
    .filter(({ subtype }) => subtype === 'link').map(({ annotationIndex }) => annotationIndex));
  return value.annotations.length <= 50 && value.widgets.length <= 50
    && value.annotations.every((annotation) => annotation && Object.keys(annotation).length === 3
    && annotationTypes.has(annotation.subtype)
    && isInteger(annotation.annotationIndex, 0, 1_000_000) && isFingerprint(annotation.fingerprint))
    && new Set(value.annotations.map(({ annotationIndex }) => annotationIndex)).size === value.annotations.length
    && new Set(value.annotations.map(({ fingerprint }) => fingerprint)).size === value.annotations.length
    && value.widgets.every((widget) => widget && Object.keys(widget).length === 6
      && isNullableString(widget.fieldName) && widgetTypes.has(widget.fieldType)
      && (widget.fieldType === 'button' ? widgetControlKinds.has(widget.controlKind) : widget.controlKind === null)
      && isInteger(widget.flags, -2_147_483_648, 2_147_483_647)
      && isInteger(widget.annotationIndex, 0, 1_000_000) && isFingerprint(widget.fingerprint))
    && new Set(value.widgets.map(({ annotationIndex }) => annotationIndex)).size === value.widgets.length
    && new Set(value.widgets.map(({ fingerprint }) => fingerprint)).size === value.widgets.length
    && value.links.length <= 50 && value.links.every((link) => link && Object.keys(link).length === 6
      && isInteger(link.annotationIndex, 0, 1_000_000) && linkAnnotationIndexes.has(link.annotationIndex)
      && validRectangle(link.rect) && linkTypes.has(link.kind)
      && (link.targetPage === null || isInteger(link.targetPage, 1, 1_000_000))
      && isNullableString(link.target) && (link.remotePage === null || isInteger(link.remotePage, 1, 1_000_000))
      && (link.kind === 'goTo' ? link.target === null && link.remotePage === null : link.targetPage === null)
      && (link.kind === 'remoteGoTo' ? link.target !== null : link.remotePage === null)
      && (!['namedAction', 'namedDestination'].includes(link.kind) || link.target !== null)
      && (link.kind !== 'unresolved' || (link.targetPage === null && link.target === null && link.remotePage === null)))
    && new Set(value.links.map(({ annotationIndex }) => annotationIndex)).size === value.links.length;
}

function validPageLabels(value, pages, pageCount) {
  if (!value || Object.keys(value).length !== 3 || !isBoolean(value.present)
    || !Array.isArray(value.items) || value.items.length > 100 || !isBoolean(value.truncated)
    || value.items.length !== pages.length || value.truncated !== (pageCount > value.items.length)) return false;
  const pageLabels = new Map(pages.map(({ index, label }) => [index, label]));
  return value.items.every((item) => item && Object.keys(item).length === 2
    && isInteger(item.page, 1, pageCount) && typeof item.label === 'string'
    && Buffer.byteLength(item.label, 'utf8') <= 1_024 && pageLabels.get(item.page) === item.label)
    && new Set(value.items.map(({ page }) => page)).size === value.items.length;
}

function validOptionalContent(value) {
  if (!value || Object.keys(value).length !== 5 || !isBoolean(value.present)
    || !isInteger(value.groupCount, 0, 1_000_000) || !Array.isArray(value.groups)
    || value.groups.length > 200 || !isBoolean(value.groupsTruncated)
    || !isBoolean(value.defaultConfigurationPresent)
    || value.groupsTruncated !== (value.groupCount > value.groups.length)) return false;
  if (!value.present && (value.groupCount !== 0 || value.groups.length !== 0
    || value.groupsTruncated || value.defaultConfigurationPresent)) return false;
  return value.groups.every((group, index) => group && Object.keys(group).length === 3
    && group.index === index && isNullableString(group.name)
    && (group.defaultVisible === null || isBoolean(group.defaultVisible)));
}

function validOutlineItem(value, state = { count: 0 }, depth = 0, maximumPage = 1_000_000, topLevelIndex = null) {
  state.count += 1;
  const locator = value?.removalLocator;
  const validLocator = locator === null || (depth === 0 && locator
    && Object.keys(locator).length === 2
    && locator.topLevelIndex === topLevelIndex && isFingerprint(locator.fingerprint)
    && typeof value.title === 'string' && isInteger(value.page, 1, maximumPage)
    && Array.isArray(value.children) && value.children.length === 0);
  return state.count <= 200 && depth < 8 && value && Object.keys(value).length === 4 && isNullableString(value.title)
    && (value.page === null || isInteger(value.page, 1, maximumPage))
    && validLocator && Array.isArray(value.children)
    && value.children.every((child) => validOutlineItem(child, state, depth + 1, maximumPage, null));
}

export function validInspectionResult(value) {
  if (!value || Object.keys(value).length !== 7 || !value.document || !value.metadata || !value.outline
    || !value.pageLabels || !value.optionalContent || !Array.isArray(value.pages) || !isBoolean(value.pagesTruncated)) return false;
  const { document, metadata, outline } = value;
  const outlineState = { count: 0 };
  const documentKeys = ['pageCount', 'encrypted', 'locked', 'permissions', 'supportedAnnotationTypes'];
  const metadataKeys = ['title', 'author', 'subject', 'creator', 'producer', 'creationDate', 'modificationDate', 'keywords'];
  const permissionKeys = ['copying', 'printing', 'changes', 'commenting', 'formFieldEntry', 'assembly', 'contentAccessibility', 'status'];
  return Object.keys(document).length === documentKeys.length && documentKeys.every((key) => key in document)
    && isInteger(document.pageCount, 0, 1_000_000) && isBoolean(document.encrypted) && isBoolean(document.locked)
    && document.permissions && Object.keys(document.permissions).length === permissionKeys.length
    && permissionKeys.slice(0, -1).every((key) => isBoolean(document.permissions[key]))
    && new Set(['none', 'user', 'owner', 'unknown']).has(document.permissions.status)
    && Array.isArray(document.supportedAnnotationTypes) && document.supportedAnnotationTypes.length === annotationTypes.size
    && document.supportedAnnotationTypes.every((type) => annotationTypes.has(type))
    && new Set(document.supportedAnnotationTypes).size === annotationTypes.size
    && Object.keys(metadata).length === metadataKeys.length && metadataKeys.every((key) => isNullableString(metadata[key]))
    && value.pages.length <= 100 && value.pages.every(validPage)
    && Object.keys(outline).length === 2 && Array.isArray(outline.items) && isBoolean(outline.truncated)
    && outline.items.every((item, index) => validOutlineItem(item, outlineState, 0, document.pageCount, index))
    && new Set(outline.items.flatMap((item) => item.removalLocator?.fingerprint ?? [])).size
      === outline.items.filter((item) => item.removalLocator !== null).length
    && validPageLabels(value.pageLabels, value.pages, document.pageCount) && validOptionalContent(value.optionalContent);
}

export function parsePdfkitResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!validInspectionResult(result)) throw responseError();
  return result;
}
