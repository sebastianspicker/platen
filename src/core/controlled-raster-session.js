export const CONTROLLED_RASTER_DPI = 192;
export const CONTROLLED_RASTER_MAX_EDGE = CONTROLLED_RASTER_DPI * 12;
const MAX_CONTROLLED_RASTER_BYTES = 16 * 1024 * 1024;

const idleSnapshot = Object.freeze({ status: 'idle', page: null, dpi: CONTROLLED_RASTER_DPI, url: null, error: null });

function snapshot(status, page, dpi, url = null, error = null) {
  return Object.freeze({ status, page, dpi, url, error });
}

function validDocumentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
}

export class ControlledRasterSession {
  #fetchPage;
  #decodeBlob;
  #createObjectUrl;
  #revokeObjectUrl;
  #onChange;
  #controller = null;
  #generation = 0;
  #url = null;
  #snapshot = idleSnapshot;

  constructor({ fetchPage, decodeBlob, createObjectUrl, revokeObjectUrl, onChange = () => {} } = {}) {
    if (![fetchPage, decodeBlob, createObjectUrl, revokeObjectUrl, onChange].every((value) => typeof value === 'function')) {
      throw new TypeError('ControlledRasterSession requires page, decode, object URL, and change handlers.');
    }
    this.#fetchPage = fetchPage;
    this.#decodeBlob = decodeBlob;
    this.#createObjectUrl = createObjectUrl;
    this.#revokeObjectUrl = revokeObjectUrl;
    this.#onChange = onChange;
  }

  get current() { return this.#snapshot; }

  #publish(value) {
    this.#snapshot = value;
    this.#onChange(value);
    return value;
  }

  #releaseUrl() {
    if (!this.#url) return;
    this.#revokeObjectUrl(this.#url);
    this.#url = null;
  }

  reset(reason = 'Controlled raster preview was reset.', { notify = true } = {}) {
    if (typeof notify !== 'boolean') throw new TypeError('notify must be a boolean.');
    this.#generation += 1;
    this.#controller?.abort(new Error(reason));
    this.#controller = null;
    this.#releaseUrl();
    this.#snapshot = idleSnapshot;
    if (notify) this.#onChange(idleSnapshot);
    return idleSnapshot;
  }

  async load(documentId, page, { dpi = CONTROLLED_RASTER_DPI } = {}) {
    if (!validDocumentId(documentId)) throw new TypeError('documentId must be an opaque local identifier.');
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new TypeError('page must be a positive bounded integer.');
    if (!Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240) throw new TypeError('dpi must be an integer from 36 through 240.');

    const generation = ++this.#generation;
    this.#controller?.abort(new Error('A newer controlled raster render started.'));
    const controller = new AbortController();
    this.#controller = controller;
    this.#releaseUrl();
    this.#publish(snapshot('loading', page, dpi));

    try {
      const blob = await this.#fetchPage(documentId, page, dpi, { signal: controller.signal });
      if (generation !== this.#generation || controller.signal.aborted) return null;
      if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size < 24 || blob.size > MAX_CONTROLLED_RASTER_BYTES) {
        throw new TypeError('Controlled raster renderer must return a PNG Blob.');
      }
      await this.#decodeBlob(blob);
      if (generation !== this.#generation || controller.signal.aborted) return null;
      const url = this.#createObjectUrl(blob);
      if (typeof url !== 'string' || !url) throw new TypeError('Controlled raster object URL is invalid.');
      if (generation !== this.#generation || controller.signal.aborted) {
        this.#revokeObjectUrl(url);
        return null;
      }
      this.#url = url;
      return this.#publish(snapshot('ready', page, dpi, url));
    } catch (error) {
      if (generation !== this.#generation || controller.signal.aborted) return null;
      const message = typeof error?.message === 'string' && error.message ? error.message : 'Local page rendering failed.';
      return this.#publish(snapshot('error', page, dpi, null, message.slice(0, 1_024)));
    } finally {
      if (generation === this.#generation) this.#controller = null;
    }
  }
}
