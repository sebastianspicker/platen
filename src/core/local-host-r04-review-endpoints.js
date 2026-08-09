import { createCommentsToOfficeEndpoints } from './local-host-comments-to-office-endpoints.js';
import { createFileAudioAttachmentEndpoints } from './local-host-file-audio-attachment-endpoints.js';
import { createFormJavaScriptInventoryEndpoints } from './local-host-form-javascript-inventory-endpoints.js';
import { createPdfXfaInspectionEndpoints } from './local-host-xfa-inspection-endpoints.js';
import { createReviewMeasurementEndpoints } from './local-host-review-measurement-endpoints.js';
import { createReviewAnnotationImportExportEndpoints } from './local-host-review-annotation-import-export-endpoints.js';
import { createReviewNotificationEndpoints } from './local-host-review-notification-endpoints.js';
import { createReviewSharedExchangeEndpoints } from './local-host-review-shared-exchange-endpoints.js';
import { createReviewSidecarEndpoints } from './local-host-review-sidecar-endpoints.js';

export function createR04ReviewEndpoints(transport) {
  const comments = createCommentsToOfficeEndpoints(transport);
  const attachments = createFileAudioAttachmentEndpoints(transport);
  const formJavaScript = createFormJavaScriptInventoryEndpoints(transport);
  const xfaInspection = createPdfXfaInspectionEndpoints(transport);
  const measurements = createReviewMeasurementEndpoints(transport);
  const annotationImportExport = createReviewAnnotationImportExportEndpoints(transport);
  const notifications = createReviewNotificationEndpoints(transport);
  const sharedExchange = createReviewSharedExchangeEndpoints(transport);
  const sidecar = createReviewSidecarEndpoints(transport);
  return Object.freeze({
    exportCommentsToOffice: comments.exportCommentsToOffice,
    addFileAudioAttachment: attachments.addFileAudioAttachment,
    inspectFormJavaScriptInventory: formJavaScript.inspectFormJavaScriptInventory,
    inspectXfaPresence: xfaInspection.inspectXfaPresence,
    createReviewMeasurement: measurements.createReviewMeasurement,
    importReviewAnnotationXfdf: annotationImportExport.importReviewAnnotationXfdf,
    generateReviewNotifications: notifications.generateReviewNotifications,
    markReviewNotificationRead: notifications.markReviewNotificationRead,
    exportReviewSharedExchange: sharedExchange.exportReviewSharedExchange,
    importReviewSharedExchange: sharedExchange.importReviewSharedExchange,
    setReviewSidecarStatus: sidecar.setReviewSidecarStatus,
    inspectReviewSidecar: sidecar.inspectReviewSidecar,
  });
}
