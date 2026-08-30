import { boundedString, canonical, createServiceOptions, hash, requireObject, requireWorkspace, unsupportedCertificateOperation } from './trust-accessibility-support.mjs';

/** Owns local signing-intent audit records and explicit certificate-operation refusal. */
export class SigningDomainService {
  #workspace;
  #clock;
  #idFactory;

  constructor(workspace, options = {}) {
    this.#workspace = requireWorkspace(workspace);
    ({ clock: this.#clock, idFactory: this.#idFactory } = createServiceOptions(options));
  }

  createElectronicSigningIntent(documentId, { documentDigest, intent, consent, route = [], appearance = {} } = {}, { expectedRevision } = {}) {
    boundedString(documentDigest, 'documentDigest', 256); requireObject(intent, 'intent'); requireObject(consent, 'consent');
    if (!Array.isArray(route) || route.length > 100) throw new TypeError('route must be a bounded array.');
    const intentHash = hash(canonical({ documentDigest, intent }));
    const localTime = this.#localTime();
    const records = [['consent', { consent }], ['routed-signature', { route, intentHash }], ['visible-appearance', { appearance }]];
    let snapshot = null; let revision = expectedRevision;
    const chain = [];
    for (const [type, data] of records) {
      const id = this.#idFactory(`sign-${type}`);
      const auditHash = hash(canonical({ previousHash: chain.at(-1)?.auditHash ?? 'genesis', id, type, intentHash, data }));
      const record = { id, type, createdAtLocal: localTime, timestampTrust: 'local-clock-label-not-trusted', intentHash, auditHash, previousHash: chain.at(-1)?.auditHash ?? 'genesis', ...data };
      snapshot = this.#workspace.createEntity(documentId, 'workflowRecords', record, { expectedRevision: revision });
      revision = snapshot.revision; chain.push(record);
    }
    const auditId = this.#idFactory('sign-audit');
    const audit = { id: auditId, type: 'audit', createdAtLocal: localTime, timestampTrust: 'local-clock-label-not-trusted', intentHash, previousHash: chain.at(-1).auditHash, auditHash: hash(canonical({ previousHash: chain.at(-1).auditHash, id: auditId, type: 'audit', intentHash })) };
    snapshot = this.#workspace.createEntity(documentId, 'workflowRecords', audit, { expectedRevision: revision });
    return Object.freeze({ snapshot, intentHash, auditRecordId: auditId, certificateSignature: unsupportedCertificateOperation('certificate-signing') });
  }

  verifyLocalSigningIntent(documentId, { documentDigest, intent } = {}) {
    const intentHash = hash(canonical({ documentDigest, intent }));
    const records = this.#workspace.snapshot(documentId).namespaces.workflowRecords.filter((record) => record.intentHash === intentHash);
    let previousHash = 'genesis';
    const chainValid = records.length === 4 && records.every((record) => {
      let data;
      if (record.type === 'consent') data = { consent: record.consent };
      else if (record.type === 'routed-signature') data = { route: record.route, intentHash };
      else if (record.type === 'visible-appearance') data = { appearance: record.appearance };
      else if (record.type === 'audit') data = null;
      else return false;
      const expected = data === null ? hash(canonical({ previousHash, id: record.id, type: 'audit', intentHash })) : hash(canonical({ previousHash, id: record.id, type: record.type, intentHash, data }));
      const valid = record.previousHash === previousHash && record.auditHash === expected;
      previousHash = record.auditHash;
      return valid;
    });
    return Object.freeze({ status: chainValid ? 'local-intent-verified' : 'local-intent-invalid', intentHash, auditChainValid: chainValid, certificateValid: false, timestampTrusted: false, recordCount: records.length });
  }

  certificateSigning() { return unsupportedCertificateOperation('certificate-signing'); }
  certificateTrust() { return unsupportedCertificateOperation('certificate-trust'); }
  certificateRevocation() { return unsupportedCertificateOperation('certificate-revocation'); }
  certificateLtv() { return unsupportedCertificateOperation('long-term-validation'); }
  digitalId() { return unsupportedCertificateOperation('digital-id'); }

  #localTime() { return boundedString(this.#clock(), 'clock value', 128); }
}
