import { fail } from './support.mjs';
import {
  opSignCertificate,
} from './real-ops.mjs';

export const handlers = Object.freeze({
  async 'sign.certificate'(ctx = {}) { return opSignCertificate(ctx); },
  async 'sign.routed-workflow'() { fail('ROUTED_SIGNATURE_UNAVAILABLE', 'The production routed-signature workflow is unavailable.', 503); },
  async 'sign.audit-trail'() { fail('SIGNATURE_AUDIT_UNAVAILABLE', 'The production signing audit service is unavailable.', 503); },
  async 'sign.timestamp'() { fail('TIMESTAMP_AUTHORITY_UNAVAILABLE', 'A trusted timestamp authority is unavailable; hash-only timestamps are not admitted.', 503); },
  async 'sign.certify-document'() { fail('CERTIFICATION_AUTHORITY_UNAVAILABLE', 'A production certification-signature authority is unavailable.', 503); },
  async 'sign.trust-store'() { fail('TRUST_STORE_UNAVAILABLE', 'A production certificate trust-store authority is unavailable.', 503); },
  async 'sign.revocation-ltv'() { fail('REVOCATION_AUTHORITY_UNAVAILABLE', 'Production OCSP/CRL and LTV authorities are unavailable.', 503); },
  async 'sign.visible-appearance'() { fail('VISIBLE_SIGNATURE_UNAVAILABLE', 'The production visible certificate-signature service is unavailable.', 503); },
  async 'sign.digital-id-management'() { fail('SIGNING_IDENTITY_DIRECTORY_UNAVAILABLE', 'The production signing-identity directory is unavailable.', 503); },
  async 'sign.batch-sign-seal'() { fail('BATCH_SIGNATURE_UNAVAILABLE', 'The production batch-signature service is unavailable.', 503); },
  async 'sign.identity-verification'() { fail('IDENTITY_VERIFICATION_UNAVAILABLE', 'The production signing-identity verification service is unavailable.', 503); },
});
