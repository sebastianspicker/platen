export function normalizedRectangle(value, label) {
  const rectangle = Object.fromEntries(
    Object.entries(value ?? {}).map(([key, entry]) => [key, Number(entry)]),
  );
  if (Object.values(rectangle).some((entry) => !Number.isFinite(entry))
    || rectangle.x < 0 || rectangle.y < 0
    || rectangle.width <= 0 || rectangle.height <= 0
    || rectangle.x + rectangle.width > 1
    || rectangle.y + rectangle.height > 1) {
    throw new Error(`${label} must be a normalized rectangle fully inside the page.`);
  }
  return rectangle;
}
