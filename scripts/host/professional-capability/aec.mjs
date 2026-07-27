/**
 * AEC professional capability registry.
 * Domain implementations live in aec-ops.mjs / aec-ops-extra.mjs.
 */
export {
  aecMeasurement,
  aecScaleCalibration,
  aecTakeoff,
  aecBatchLink,
  aecOfflineProjects,
  aecCollaborativeReviewSessions,
  aecMeasurementToolset,
  aecMarkupToolsets,
  aecMarkupsList,
  aecCustomColumnsFormulas,
} from './aec-ops.mjs';

export {
  aecSpacesRegions,
  aecSetsDrawingLog,
  aecSheetMetadataTags,
  aecRevisionOverlay,
  aecBatchSlipSheet,
  aecLegends,
  aecRevisionStatusWorkflows,
  aecGeospatialDocuments,
} from './aec-ops-extra.mjs';

import {
  aecMeasurement,
  aecScaleCalibration,
  aecTakeoff,
  aecBatchLink,
  aecOfflineProjects,
  aecCollaborativeReviewSessions,
  aecMeasurementToolset,
  aecMarkupToolsets,
  aecMarkupsList,
  aecCustomColumnsFormulas,
} from './aec-ops.mjs';
import {
  aecSpacesRegions,
  aecSetsDrawingLog,
  aecSheetMetadataTags,
  aecRevisionOverlay,
  aecBatchSlipSheet,
  aecLegends,
  aecRevisionStatusWorkflows,
  aecGeospatialDocuments,
} from './aec-ops-extra.mjs';

export const handlers = Object.freeze({
  async 'aec.measurement'(ctx = {}) { return aecMeasurement(ctx); },
  async 'aec.scale-calibration'(ctx = {}) { return aecScaleCalibration(ctx); },
  async 'aec.takeoff'(ctx = {}) { return aecTakeoff(ctx); },
  async 'aec.batch-link'(ctx = {}) { return aecBatchLink(ctx); },
  async 'aec.offline-projects'(ctx = {}) { return aecOfflineProjects(ctx); },
  async 'aec.collaborative-review-sessions'(ctx = {}) { return aecCollaborativeReviewSessions(ctx); },
  async 'aec.measurement-toolset'(ctx = {}) { return aecMeasurementToolset(ctx); },
  async 'aec.markup-toolsets'(ctx = {}) { return aecMarkupToolsets(ctx); },
  async 'aec.markups-list'(ctx = {}) { return aecMarkupsList(ctx); },
  async 'aec.custom-columns-formulas'(ctx = {}) { return aecCustomColumnsFormulas(ctx); },
  async 'aec.spaces-regions'(ctx = {}) { return aecSpacesRegions(ctx); },
  async 'aec.sets-drawing-log'(ctx = {}) { return aecSetsDrawingLog(ctx); },
  async 'aec.sheet-metadata-tags'(ctx = {}) { return aecSheetMetadataTags(ctx); },
  async 'aec.revision-overlay'(ctx = {}) { return aecRevisionOverlay(ctx); },
  async 'aec.batch-slip-sheet'(ctx = {}) { return aecBatchSlipSheet(ctx); },
  async 'aec.legends'(ctx = {}) { return aecLegends(ctx); },
  async 'aec.revision-status-workflows'(ctx = {}) { return aecRevisionStatusWorkflows(ctx); },
  async 'aec.geospatial-documents'(ctx = {}) { return aecGeospatialDocuments(ctx); },
});
