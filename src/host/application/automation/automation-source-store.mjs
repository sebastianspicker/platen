import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AutomationOutputRecordStore } from './automation-output-record-store.mjs';
import { AutomationSourceRecordStore } from './automation-source-record-store.mjs';
import {
  existingPrivateDirectory, fail, syncDirectory,
} from './automation-store-support.mjs';

export class AutomationSourceStore {
  #root; #sourcesRoot; #outputsRoot; #sources; #outputs;

  constructor({ root, idFactory = randomUUID } = {}) {
    if (typeof root !== 'string' || !root || typeof idFactory !== 'function') {
      fail('INVALID_AUTOMATION_SOURCE_STORE', 'Automation source storage requires a root and ID factory.');
    }
    this.#root = resolve(root);
    this.#sourcesRoot = join(this.#root, 'sources');
    this.#outputsRoot = join(this.#root, 'outputs');
    this.#sources = new AutomationSourceRecordStore({
      root: this.#sourcesRoot, idFactory,
    });
    this.#outputs = new AutomationOutputRecordStore({
      root: this.#outputsRoot, idFactory,
    });
  }

  async initialize() {
    await existingPrivateDirectory(
      this.#root, 'AUTOMATION_ROOT_REQUIRED', 'An existing private --automation-root is required.',
    );
    let created = false;
    for (const directory of [this.#sourcesRoot, this.#outputsRoot]) {
      try { await mkdir(directory, { mode: 0o700 }); created = true; } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    await existingPrivateDirectory(
      this.#sourcesRoot, 'AUTOMATION_SOURCE_CORRUPT', 'Automation source storage is missing.',
    );
    await existingPrivateDirectory(
      this.#outputsRoot, 'AUTOMATION_OUTPUT_CORRUPT', 'Automation output storage is missing.',
    );
    if (created) await syncDirectory(this.#root);
    return this;
  }

  stageDocument(options) { return this.#sources.stageDocument(options); }
  openVerified(id, sha256) { return this.#sources.openVerified(id, sha256); }
  commit(source) { return this.#sources.commit(source); }
  discardCreated(source) { return this.#sources.discardCreated(source); }
  recoverTransactions(references) {
    return Promise.all([
      this.#sources.recoverTransactions(references),
      this.#outputs.recoverTransactions(references),
    ]).then(([sources, outputs]) => Object.freeze({ sources, outputs }));
  }

  stagePromotedArtifact(options) { return this.#outputs.stagePromotedArtifact(options); }
  openOutputVerified(id, sha256) { return this.#outputs.openVerified(id, sha256); }
  listOutputs() { return this.#outputs.list(); }
  getOutputMetadata(id) { return this.#outputs.getMetadata(id); }
  deleteOutput(id, sha256) { return this.#outputs.delete(id, sha256); }
  commitOutput(output) { return this.#outputs.commit(output); }
  discardCreatedOutput(output) { return this.#outputs.discardCreated(output); }
}
