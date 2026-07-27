import { OCR_LIMITS } from '../core/ocr-contract.js';
import { normalizedRectangle } from '../core/normalized-rectangle.js';

const SAFE_ZONE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function createOcrZoneController({ state, clearSelection }) {
  if (!state || typeof clearSelection !== 'function') {
    throw new TypeError('OCR zone controller requires state and a selection reset callback.');
  }

  function currentPageOcrZones() {
    return state.ocrZones.filter((zone) => zone.page === state.selectedPage);
  }

  function newOcrZone() {
    const pageZones = currentPageOcrZones();
    if (state.ocrZones.length >= OCR_LIMITS.maxZones
      || pageZones.length >= OCR_LIMITS.maxZonesPerPage) {
      throw new Error(
        `Choose at most ${OCR_LIMITS.maxZonesPerPage} OCR zones on this page and ${OCR_LIMITS.maxZones} total.`,
      );
    }
    const usedIds = new Set(state.ocrZones.map(({ id }) => id));
    let sequence = state.ocrZones.length + 1;
    while (usedIds.has(`zone-${sequence}`)) sequence += 1;
    const id = `zone-${sequence}`;
    const slot = pageZones.length;
    const x = 0.03 + (slot % 4) * 0.24;
    const y = 0.05 + Math.floor(slot / 4) * 0.45;
    state.ocrZones = [
      ...state.ocrZones,
      { id, type: 'text', page: state.selectedPage, x, y, width: 0.2, height: 0.3 },
    ];
    state.selectedOcrZoneId = id;
    clearSelection();
  }

  function updateSelectedOcrZone(key, value) {
    const index = state.ocrZones.findIndex((zone) => (
      zone.id === state.selectedOcrZoneId && zone.page === state.selectedPage
    ));
    if (index < 0) return;
    state.ocrZones = state.ocrZones.map((zone, zoneIndex) => (
      zoneIndex === index ? { ...zone, [key]: value } : zone
    ));
    clearSelection();
  }

  function removeSelectedOcrZone() {
    if (!state.selectedOcrZoneId) return;
    state.ocrZones = state.ocrZones.filter((zone) => zone.id !== state.selectedOcrZoneId);
    state.selectedOcrZoneId = currentPageOcrZones()[0]?.id ?? null;
    clearSelection();
  }

  function normalizedCurrentPageOcrZones() {
    const zones = currentPageOcrZones().map((zone) => ({
      ...zone,
      ...normalizedRectangle(
        { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
        `OCR zone ${zone.id}`,
      ),
    }));
    const ids = new Set();
    for (const zone of zones) {
      if (!SAFE_ZONE_ID.test(zone.id) || ids.has(zone.id)) {
        throw new Error('OCR zone IDs must be unique and use safe letters, numbers, dots, underscores, or hyphens.');
      }
      ids.add(zone.id);
      if (!['text', 'table', 'image', 'exclude'].includes(zone.type)) {
        throw new Error('Choose a valid OCR zone type.');
      }
    }
    for (let index = 0; index < zones.length; index += 1) {
      for (let other = index + 1; other < zones.length; other += 1) {
        const first = zones[index];
        const second = zones[other];
        if (first.x < second.x + second.width && second.x < first.x + first.width
          && first.y < second.y + second.height && second.y < first.y + first.height) {
          throw new Error('OCR zones must not overlap.');
        }
      }
    }
    return zones;
  }

  return Object.freeze({
    currentPageOcrZones,
    newOcrZone,
    updateSelectedOcrZone,
    removeSelectedOcrZone,
    normalizedCurrentPageOcrZones,
  });
}
