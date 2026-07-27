import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REQUEST = Buffer.from(JSON.stringify({ version: 1, operation: 'listSigningIdentities' }), 'utf8');
const MAX_IDENTITIES = 10_000;

export class SigningIdentityDirectoryService {
  #adapter; #root;
  constructor({ adapter = null, root } = {}) {
    if (root !== undefined && (typeof root !== 'string' || !root || root.includes('\0'))) throw new TypeError('root must be a bounded path.');
    this.#adapter = adapter; this.#root = root;
  }
  async list({ signal } = {}) {
    if (!this.#adapter || typeof this.#adapter.listIdentities !== 'function') {
      const error = new Error('The staged signing identity helper is unavailable.'); error.code = 'SIGNING_IDENTITY_UNAVAILABLE'; throw error;
    }
    if (!this.#root) throw new Error('Signing identity workspace root is unavailable.');
    const workspace = await mkdtemp(join(this.#root, 'signing-identities-'));
    try {
      await chmod(workspace, 0o700);
      const requestPath = join(workspace, 'request.json');
      await writeFile(requestPath, REQUEST, { mode: 0o600, flag: 'wx' });
      const result = await this.#adapter.listIdentities({ workspacePath: workspace, requestPath }, { signal, timeoutMs: 30_000 });
      const identities = Array.isArray(result?.result?.identities) ? result.result.identities : [];
      if (identities.length > MAX_IDENTITIES) throw new Error('The signing identity list exceeded its bound.');
      const deduped = new Map();
      for (const item of identities) {
        if (!/^[0-9a-f]{64}$/u.test(item?.certificateSha256 ?? '') || !Number.isSafeInteger(item?.certificateBytes) || item.certificateBytes < 1 || item.certificateBytes > 65_536) throw new Error('The signing identity list was invalid.');
        deduped.set(item.certificateSha256, Object.freeze({ certificateSha256: item.certificateSha256, certificateBytes: item.certificateBytes }));
      }
      return Object.freeze([...deduped.values()].sort((a, b) => a.certificateSha256.localeCompare(b.certificateSha256)));
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
}
