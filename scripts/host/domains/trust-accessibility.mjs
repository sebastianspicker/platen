import { AccessibilityDomainService } from './accessibility-domain.mjs';
import { RedactionDomainService } from './redaction-domain.mjs';
import { SigningDomainService } from './signing-domain.mjs';
import { createServiceOptions, requireWorkspace } from './trust-accessibility-support.mjs';

export { AccessibilityDomainService } from './accessibility-domain.mjs';
export { RedactionDomainService } from './redaction-domain.mjs';
export { SigningDomainService } from './signing-domain.mjs';

/** @deprecated Compatibility facade for direct imports; new callers should select one owner service. */
export class TrustAccessibilityDomainService {
  #redaction;
  #accessibility;
  #signing;

  constructor(workspace, options = {}) {
    requireWorkspace(workspace);
    const sharedOptions = createServiceOptions(options);
    this.#redaction = new RedactionDomainService(workspace, sharedOptions);
    this.#accessibility = new AccessibilityDomainService(workspace, sharedOptions);
    this.#signing = new SigningDomainService(workspace, sharedOptions);
  }

  detectSensitiveText(...args) { return this.#redaction.detectSensitiveText(...args); }
  createRedactionPlan(...args) { return this.#redaction.createRedactionPlan(...args); }
  applyRedactions(...args) { return this.#redaction.applyRedactions(...args); }
  inspectAccessibility(...args) { return this.#accessibility.inspectAccessibility(...args); }
  exportAccessibilityReport(...args) { return this.#accessibility.exportAccessibilityReport(...args); }
  proposeAccessibilityRemediation(...args) { return this.#accessibility.proposeAccessibilityRemediation(...args); }
  createElectronicSigningIntent(...args) { return this.#signing.createElectronicSigningIntent(...args); }
  verifyLocalSigningIntent(...args) { return this.#signing.verifyLocalSigningIntent(...args); }
  certificateSigning(...args) { return this.#signing.certificateSigning(...args); }
  certificateTrust(...args) { return this.#signing.certificateTrust(...args); }
  certificateRevocation(...args) { return this.#signing.certificateRevocation(...args); }
  certificateLtv(...args) { return this.#signing.certificateLtv(...args); }
  digitalId(...args) { return this.#signing.digitalId(...args); }
}
