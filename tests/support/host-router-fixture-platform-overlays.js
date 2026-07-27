function createPdfKitOverlays() {
  const pdfkitInspections = {
    inspect: async (_documentId, options) => ({
      kind: 'pdfkit-structure-inspection', sourceDigest: 'b'.repeat(64), pageCount: 1,
      document: { pageCount: 1 }, metadata: {}, pages: [], pagesTruncated: false,
      outline: { items: [], truncated: false },
      evidence: { operationMode: 'inventory-only' }, options,
    }),
  };
  const pdfkitOutlineSplits = {
    calls: [],
    async split(documentId, options) {
      this.calls.push({ documentId, options });
      return [{ id: 'outline-split-1' }];
    },
  };
  const pdfkitMutations = {
    calls: [],
    async mutate(documentId, mutation, options) {
      this.calls.push({ documentId, mutation, options });
      return {
        kind: 'pdfkit-structure-mutation', artifact: { id: 'derived' },
        sourceDigest: 'c'.repeat(64),
      };
    },
  };
  const pdfkitProtection = {
    calls: [],
    removalCalls: [],
    async protect(_documentId, protection, options) {
      this.calls.push({ documentId: _documentId, protection, options });
      return {
        kind: 'pdfkit-password-protection', sourceDigest: 'c'.repeat(64),
        artifact: { id: 'protected' },
        protection: { permissionsProfile: protection.permissionsProfile },
      };
    },
    async removeProtection(_documentId, removal, options) {
      this.removalCalls.push({ documentId: _documentId, removal, options });
      return {
        kind: 'pdfkit-protection-removal', sourceDigest: removal.artifactSha256,
        artifact: { id: 'unprotected' }, protection: { encrypted: false },
      };
    },
  };
  const pdfkitSanitization = {
    calls: [],
    async sanitizeMetadata(documentId, options) {
      this.calls.push({ documentId, options });
      return {
        kind: 'pdfkit-metadata-sanitization', sourceDigest: options.sourceSha256,
        artifact: { id: 'metadata-sanitized' },
        sanitization: { removedCategories: ['document-info'] },
      };
    },
  };
  const pdfkitTextFieldWidget = {
    calls: [],
    async addTextFieldWidget(documentId, request) {
      this.calls.push({ documentId, request });
      return {
        kind: 'pdfkit-acroform-text-field-widget',
        sourceDigest: request.sourceSha256,
        artifact: { id: 'text-field-widget' },
      };
    },
  };
  const incrementalMetadata = {
    calls: [],
    async update(documentId, metadata, options) {
      this.calls.push({ documentId, metadata, options });
      return {
        kind: 'pdf-incremental-metadata', sourceDigest: options.sourceSha256,
        artifact: { id: 'incremental-metadata' },
        metadata: {
          profile: 'local-classic-incremental-metadata-v1',
          updatedFields: ['title', 'author', 'subject', 'keywords'],
        },
      };
    },
  };
  return {
    pdfkitInspections, pdfkitOutlineSplits, pdfkitMutations,
    pdfkitProtection, pdfkitSanitization, pdfkitTextFieldWidget, incrementalMetadata,
  };
}

export function createPlatformOverlays() {
  const pdfkit = createPdfKitOverlays();
  const aecArtifacts = {
    nativeAvailable: true,
    calls: [],
    async calibrate(documentId, body, options) {
      this.calls.push({ operation: 'calibrate', documentId, body, options });
      return { kind: 'calibration', body };
    },
    async measure(documentId, body, options) {
      this.calls.push({ operation: 'measure', documentId, body, options });
      return { kind: 'measurement', body };
    },
    async materialize(documentId, body, options) {
      this.calls.push({ operation: 'materialize', documentId, body, options });
      return { kind: 'materialization', body };
    },
  };
  const pluginSandboxStatus = {
    calls: 0,
    async getStatus() {
      this.calls += 1;
      return {
        schemaVersion: 1, kind: 'plugin-sandbox-status', status: 'blocked',
        executionReady: false, pluginCodeExecuted: false,
        cacheScope: 'host-session', observedAtLocal: '2026-01-01T00:00:00.000Z',
        probeAvailable: false,
        hardControls: {
          osSandbox: false, noNetwork: false, processQuota: false,
          cpuQuota: false, hardMemoryQuota: false,
        },
        bestEffortEvidence: {
          sandboxBehaviorProbe: false, filesystemWriteDenied: false,
          sensitiveFilesystemReadDenied: false, networkCanaryDenied: false,
          processForkCanaryDenied: false, nodePermissionProbe: false,
          cpuLimitCanary: false, jitless: false,
        },
        missingHardControls: [
          'osSandbox', 'noNetwork', 'processQuota', 'cpuQuota', 'hardMemoryQuota',
        ],
        reasonCode: 'PROBE_UNAVAILABLE',
      };
    },
  };
  return { ...pdfkit, aecArtifacts, pluginSandboxStatus };
}
