export const PDFKIT_WORKFLOW_SHA256 = /^[0-9a-f]{64}$/;

export function selectedPdfKitInventoryPage(state) {
  return state.pdfkitInspectionResult?.pages?.find(
    (entry) => entry.index === state.selectedPage,
  );
}

export function boundedPdfKitRectangle(state, value, label, boxName = 'media') {
  const rectangle = Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [key, Number(value?.[key])]),
  );
  if (Object.values(rectangle).some((number) => !Number.isFinite(number)
    || Math.abs(number) > 1_000_000)
    || rectangle.width <= 0 || rectangle.height <= 0) {
    throw new Error(`${label} must use finite point coordinates and positive dimensions.`);
  }
  const box = selectedPdfKitInventoryPage(state)?.boxes?.[boxName];
  if (!box || rectangle.x < box.x || rectangle.y < box.y
    || rectangle.x + rectangle.width > box.x + box.width
    || rectangle.y + rectangle.height > box.y + box.height) {
    throw new Error(`${label} must be fully contained in the inspected ${boxName === 'crop' ? 'CropBox' : 'MediaBox'} for page ${state.selectedPage}.`);
  }
  return rectangle;
}

export function boundedPdfKitPoint(state, value, label) {
  const point = { x: Number(value?.x), y: Number(value?.y) };
  if (Object.values(point).some((number) => !Number.isFinite(number)
    || Math.abs(number) > 1_000_000)) {
    throw new Error(`${label} must use finite point coordinates.`);
  }
  const crop = selectedPdfKitInventoryPage(state)?.boxes?.crop;
  if (!crop || point.x < crop.x || point.y < crop.y
    || point.x > crop.x + crop.width || point.y > crop.y + crop.height) {
    throw new Error(`${label} must lie inside the inspected CropBox for page ${state.selectedPage}.`);
  }
  return point;
}

export function boundedPdfKitContents(value, label) {
  const contents = String(value ?? '');
  const byteLength = new TextEncoder().encode(contents).byteLength;
  if (byteLength < 1 || byteLength > 1_024) {
    throw new Error(`${label} must contain 1 through 1,024 UTF-8 bytes.`);
  }
  return contents;
}
