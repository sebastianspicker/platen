import { emptyAnalysis } from '../../core/app-state.js';
import { resetPageNavigation } from '../../core/navigation-history.js';
import { resetPdfKitDocumentState } from './pdfkit-state-reset.js';

export function resetDocumentState(state, clearOcrLayoutSelection, { opening }) {
  state.zoom = 1;
  state.rotation = 0;
  state.selectedPage = 1;
  state.searchQuery = '';
  state.searchResults = [];
  state.pageOrder = [];
  state.ocrResult = null;
  state.ocrUserDictionary = '';
  state.ocrSuspectReviewStates = [];
  state.ocrZones = [];
  state.selectedOcrZoneId = null;
  clearOcrLayoutSelection();
  state.domainResult = null;
  state.domainError = null;
  state.domainBusy = false;
  state.domainRevision = 0;
  state.aecLastCalibrationId = null;
  state.aecLastMeasurementId = null;
  state.viewerMode = 'native'; state.viewerPageLayout = 'single';
  state.snapshotRegion = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  state.snapshotDpi = '192';
  state.showGrid = false;
  state.presentationMode = false;
  const navigation = resetPageNavigation();
  state.navigationHistory = [...navigation.history];
  state.navigationIndex = navigation.index;
  state.comparisonReport = null;
  state.comparisonFileName = null;
  state.redactionFullPage = false;
  state.redactionPlans = [];
  state.selectedRedactionPlanId = '';
  state.selectedRedactionMarkId = '';
  state.fullPageRedactionResult = null;
  state.prepressResult = null;
  state.standardsValidationResult = null;
  state.accessibilityReviewResult = null;
  state.accessibilityAltTextCandidateLocator = '';
  state.accessibilityAltText = '';
  state.accessibilityAltTextProposalResult = null;
  state.accessibilityDocumentLanguage = '';
  state.accessibilityDocumentTitle = '';
  state.incrementalAccessibilityMetadataResult = null;
  resetPdfKitDocumentState(state);
  state.acroFormCheckboxFieldName = 'check-1';
  state.acroFormTextFieldName = 'text-1';
  state.acroFormTextFieldPage = '1';
  state.acroFormTextFieldRect = { x: 36, y: 36, width: 180, height: 24 };
  state.acroFormCheckboxPage = '1';
  state.acroFormCheckboxRect = { x: 36, y: 36, width: 18, height: 18 };
  state.acroFormRadioGroupName = 'choice-1';
  state.acroFormRadioOptions = [
    { label: 'Option 1', page: '1', rect: { x: 36, y: 36, width: 18, height: 18 } },
    { label: 'Option 2', page: '1', rect: { x: 36, y: 64, width: 18, height: 18 } },
  ];
  state.acroFormStatus = 'idle';
  state.acroFormError = null;
  state.acroFormResult = null;
  state.aecMeasurementIds = []; state.aecLegendStatus = 'idle'; state.aecLegendError = null; state.aecLegendResult = null;
  state.scannerDiscoveryStatus = 'idle'; state.scannerDiscoveryError = null; state.scannerDiscoveryResult = null; state.scannerDiscoveryEvidence = null; state.scannerDevices = [];
  state.scannerAcquisitionStatus = 'idle'; state.scannerAcquisitionError = null; state.scannerAcquisitionResult = null; state.scannerAcquisitionEvidence = null;
  state.batesStatus = 'idle'; state.batesError = null; state.batesResult = null;
  state.analysis = emptyAnalysis(opening ? 'loading' : 'idle');
  if (opening) state.analysis.progress = 'Preparing local analysis…';
  state.error = null;
  if (opening) {
    state.view = 'editor';
  } else {
    state.busyAction = null;
    state.canCancel = false;
  }
}
