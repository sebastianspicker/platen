import { state } from './view-render-fixture.js';

const digest = 'a'.repeat(64);

const openDocument = (name) => ({
  isOpen: true,
  name,
  size: 4096,
  type: 'application/pdf',
  objectUrl: `blob:${name}`,
  modified: false,
});

const analysis = (pageCount = 1, form = 'none') => ({
  status: 'ready', documentId: 'doc', inspection: { pageCount, form }, structure: {},
  textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
  signatures: { status: 'unsigned', count: 0, signatureCount: 0 }, sha256: digest,
});

const inspectionEnvelope = (pages = []) => ({
  kind: 'pdfkit-structure-inspection', pageCount: Math.max(1, pages.length),
  sourceDigest: digest, metadata: {}, pages,
  outline: { items: [], truncated: false },
  pageLabels: { present: false, items: [], truncated: false },
  optionalContent: {
    present: false, groupCount: 0, groups: [], groupsTruncated: false,
    defaultConfigurationPresent: false,
  },
});

export const fullPdfKitState = () => state({
  document: openDocument('structure.pdf'),
  host: {
    status: 'ready', pdfkitInspectionReady: true, pdfkitOutlineSplitReady: true,
    pdfkitMutationReady: true, engines: [],
  },
  analysis: {
    ...analysis(1, 'AcroForm'),
    structure: {
      namedDestinations: {
        items: [{ page: 1, name: '<destination>', destination: '[ XYZ ]' }], truncated: false,
      },
    },
  },
  pdfkitInspectionResult: {
    ...inspectionEnvelope(), pageCount: 2,
    metadata: { title: '<script>title</script>' },
    pages: [{
      index: 1, label: '<Front-i>', boxes: { media: { x: 0, y: 0, width: 612, height: 792 } },
      annotations: [
        { subtype: 'link', annotationIndex: 0, fingerprint: 'b'.repeat(64) },
        { subtype: 'freeText', annotationIndex: 2, fingerprint: 'd'.repeat(64) },
        { subtype: 'widget', annotationIndex: 3, fingerprint: 'e'.repeat(64) },
        { subtype: 'widget', annotationIndex: 4, fingerprint: '8'.repeat(64) },
      ],
      widgets: [
        { fieldName: 'name', fieldType: 'text', controlKind: null, flags: 0, annotationIndex: 1, fingerprint: 'c'.repeat(64) },
        { fieldName: '<approval>', fieldType: 'button', controlKind: 'checkbox', flags: 0, annotationIndex: 3, fingerprint: 'f'.repeat(64) },
        { fieldName: '<delivery>', fieldType: 'button', controlKind: 'radio', flags: 32768, annotationIndex: 4, fingerprint: '7'.repeat(64) },
      ],
      links: [{ annotationIndex: 0, kind: 'url', targetPage: null, target: '<https://example.test>', remotePage: null }],
    }],
    outline: {
      items: [
        { title: '<chapter>', page: 1, children: [], removalLocator: null },
        { title: '<unresolved outline>', page: null, children: [], removalLocator: null },
      ],
      truncated: true,
    },
    pageLabels: {
      present: true,
      items: [{ page: 1, label: '<Front-i>' }, { page: 2, label: '<Body-3>' }],
      truncated: false,
    },
    optionalContent: {
      present: true, groupCount: 1,
      groups: [{ index: 0, name: '<Review layer>', defaultVisible: true }], groupsTruncated: false,
      defaultConfigurationPresent: true,
    },
  },
  pdfkitMetadata: { title: '<metadata>', author: '', subject: '', keywords: '' },
  pdfkitPageBox: 'crop', pdfkitPageBoxRect: { x: 0, y: 0, width: 600, height: 780 },
  pdfkitAnnotationSubtype: 'text', pdfkitAnnotationContents: '<review>',
  pdfkitAnnotationRect: { x: 36, y: 36, width: 180, height: 80 },
  pdfkitWidgetIndex: '1', pdfkitFormValue: '<private-value>',
  pdfkitLinkTargetPage: '1', pdfkitLocalLinkRemovalIndex: '0',
  pdfkitLinkRect: { x: 30, y: 30, width: 140, height: 24 },
  pdfkitOutlineLabel: '<private-bookmark>', pdfkitOutlineTargetPage: '1',
  pdfkitLineContents: '<private-line>', pdfkitLineStart: { x: 40, y: 50 },
  pdfkitLineEnd: { x: 180, y: 210 }, pdfkitInkContents: '<private-ink>',
  pdfkitInkPoints: '<40,50;90,120;180,210>', pdfkitExistingAnnotationIndex: '2',
  pdfkitExistingAnnotationContents: '<replacement>',
  pdfkitExistingAnnotationRect: { x: 40, y: 40, width: 170, height: 70 },
  pdfkitMutationResult: {
    kind: 'pdfkit-structure-mutation', appliedEdits: 1,
    artifact: { displayName: '<derived>.pdf' },
    limitations: ['Existing <signature> may be invalid.'],
  },
});

export const emptyOutlineState = () => state({
  document: openDocument('no-outline.pdf'),
  host: { status: 'ready', pdfkitInspectionReady: true, engines: [] },
  analysis: analysis(),
  pdfkitInspectionResult: inspectionEnvelope(),
});

const widgetState = (widget, widgetIndex) => state({
  document: openDocument(`${widget.controlKind}.pdf`),
  host: { status: 'ready', pdfkitMutationReady: true, engines: [] },
  analysis: analysis(1, 'AcroForm'), selectedPage: 1,
  pdfkitInspectionResult: {
    sourceDigest: digest, pageCount: 1,
    pages: [{ index: 1, annotations: [], widgets: [widget] }],
  },
  pdfkitWidgetIndex: widgetIndex,
  ...(widget.controlKind === 'checkbox' ? { pdfkitButtonState: 'off' } : {}),
});

export const checkboxState = () => widgetState({
  fieldName: '<consent>', fieldType: 'button', controlKind: 'checkbox', flags: 0,
  annotationIndex: 3, fingerprint: 'f'.repeat(64),
}, '3');

export const radioState = () => widgetState({
  fieldName: '<delivery>', fieldType: 'button', controlKind: 'radio', flags: 32768,
  annotationIndex: 4, fingerprint: '7'.repeat(64),
}, '4');

export const localLinkState = () => state({
  document: openDocument('links.pdf'),
  host: { status: 'ready', pdfkitMutationReady: true, engines: [] },
  analysis: analysis(2), selectedPage: 1,
  pdfkitInspectionResult: {
    sourceDigest: digest, pageCount: 2,
    pages: [{
      index: 1, rotation: 0, boxes: { crop: { x: 0, y: 0, width: 612, height: 792 } },
      annotations: [{ annotationIndex: 0, subtype: 'link', fingerprint: 'b'.repeat(64) }],
      annotationsTruncated: false, widgets: [],
      links: [{
        annotationIndex: 0, kind: 'goTo', targetPage: 2, target: null, remotePage: null,
        rect: { x: 30, y: 30, width: 140, height: 24 },
      }],
      linksTruncated: false,
    }],
    outline: {
      items: [{
        title: '<removable appendix>', page: 2, children: [],
        removalLocator: { topLevelIndex: 0, fingerprint: 'e'.repeat(64) },
      }],
      truncated: false,
    },
  },
  pdfkitLinkTargetPage: '2', pdfkitLocalLinkRemovalIndex: '0',
  pdfkitOutlineLabel: '<private-bookmark>', pdfkitOutlineTargetPage: '2',
  pdfkitOutlineRemovalIndex: '0', pdfkitOutlineRenameIndex: '0',
  pdfkitOutlineRenameLabel: '<renamed appendix>', pdfkitPageRotation: '90',
  pdfkitLinkRect: { x: 30, y: 30, width: 140, height: 24 },
  pdfkitLineContents: 'review line', pdfkitLineStart: { x: 40, y: 50 },
  pdfkitLineEnd: { x: 180, y: 210 }, pdfkitInkContents: 'review ink',
  pdfkitInkPoints: '40,50;90,120;180,210',
});

export const unavailablePdfKitState = () => state({
  document: openDocument('structure.pdf'),
  host: {
    status: 'ready', pdfkitInspectionReady: false, pdfkitMutationReady: false, engines: [],
  },
  analysis: analysis(),
});
