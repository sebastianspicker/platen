import { PlatenError } from './errors.js';

const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf']);
export const MAX_LOCAL_PDF_BYTES = 512 * 1024 * 1024;

function isPdfCandidate(file) {
  if (!file || typeof file !== 'object') return false;
  const name = typeof file.name === 'string' ? file.name : '';
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  if (type && !PDF_MIME_TYPES.has(type)) return false;
  return PDF_MIME_TYPES.has(type) || name.toLowerCase().endsWith('.pdf');
}

async function hasPdfHeader(file) {
  if (typeof file.slice !== 'function') return false;
  const prefix = file.slice(0, Math.min(1024, Number(file.size) || 1024));
  if (typeof prefix.arrayBuffer !== 'function') return false;
  const bytes = new Uint8Array(await prefix.arrayBuffer());
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d];
  return bytes.some((_, index) => signature.every((value, offset) => bytes[index + offset] === value));
}

function safeName(file) {
  const name = typeof file?.name === 'string' ? file.name.trim() : '';
  return name || 'local-document.pdf';
}

export class DocumentSession {
  #file = null;
  #objectUrl = null;
  #urlApi;
  #listeners = new Set();

  constructor({ urlApi = globalThis.URL } = {}) {
    if (!urlApi?.createObjectURL || !urlApi?.revokeObjectURL) {
      throw new PlatenError('URL_API_UNAVAILABLE', 'This browser cannot create a local PDF preview URL.');
    }
    this.#urlApi = urlApi;
  }

  get snapshot() {
    if (!this.#file) {
      return Object.freeze({
        isOpen: false,
        name: null,
        size: 0,
        type: null,
        objectUrl: null,
        modified: false,
      });
    }

    return Object.freeze({
      isOpen: true,
      name: safeName(this.#file),
      size: Number(this.#file.size) || 0,
      type: this.#file.type || 'application/pdf',
      objectUrl: this.#objectUrl,
      modified: false,
    });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Document session subscriber must be a function.');
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async open(file, { shouldCommit = () => true } = {}) {
    if (typeof shouldCommit !== 'function') {
      throw new TypeError('shouldCommit must be a function.');
    }
    if (!isPdfCandidate(file)) {
      throw new PlatenError('NOT_A_PDF', 'Choose a PDF file. Other file types are not accepted by this scaffold.');
    }
    if (Number(file.size) === 0) {
      throw new PlatenError('EMPTY_FILE', 'The selected PDF is empty.');
    }
    if (Number(file.size) > MAX_LOCAL_PDF_BYTES) {
      throw new PlatenError('FILE_TOO_LARGE', 'The selected PDF exceeds the 512 MB local preview limit.');
    }
    if (!(await hasPdfHeader(file))) {
      throw new PlatenError('INVALID_PDF_HEADER', 'The selected file does not contain a PDF header in its first 1,024 bytes.');
    }
    if (!shouldCommit()) {
      throw new PlatenError('OPEN_SUPERSEDED', 'A newer PDF selection replaced this open request.');
    }

    const nextUrl = this.#urlApi.createObjectURL(file);
    const previousUrl = this.#objectUrl;
    this.#file = file;
    this.#objectUrl = nextUrl;
    if (previousUrl) this.#urlApi.revokeObjectURL(previousUrl);
    this.#emit();
    return this.snapshot;
  }

  close() {
    if (this.#objectUrl) this.#urlApi.revokeObjectURL(this.#objectUrl);
    this.#file = null;
    this.#objectUrl = null;
    this.#emit();
    return this.snapshot;
  }

  getOriginal() {
    if (!this.#file) {
      throw new PlatenError('NO_DOCUMENT', 'Open a PDF before downloading it.');
    }
    return this.#file;
  }

  dispose() {
    this.close();
    this.#listeners.clear();
  }

  #emit() {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export { hasPdfHeader, isPdfCandidate };
