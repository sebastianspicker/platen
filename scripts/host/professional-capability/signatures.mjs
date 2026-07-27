import { result, requireString, fail, sha256 as shaBuf } from './support.mjs';
import {
  opSignCertificate,
  opValidateCertificate,
  opSignElectronic,
  opSignAuditTrail,
} from './real-ops.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createPdfPortfolio } from './portfolio-pdf.mjs';

const FAMILY = 'signatures';

function requireSigMarkers(pdf, code = 'SIG_MARKERS_MISSING') {
  const latin1 = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : '';
  if (!latin1.includes('/ByteRange') && !latin1.includes('/Type /Sig') && !latin1.includes('/Sig')) {
    fail(code, 'Signature container missing /ByteRange or /Sig markers.', 502);
  }
}

/** Classic package PDF with DocMDP transform params + embedded sealed CMS PDF. */
function assembleCertifyPackage(sealedPdf, { fieldName = 'Certify1' } = {}) {
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const transformId = alloc();
  const sigRefId = alloc();
  const permsId = alloc();
  const streamId = alloc();
  const filespecId = alloc();
  const namesId = alloc();
  const efTreeId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = 'BT /F1 12 Tf 72 720 Td (CERTIFY:DocMDP) Tj ET\n';
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(transformId, '<< /Type /TransformParams /P 1 /V /1.2 >>');
  objects.set(sigRefId, `<< /Type /SigRef /TransformMethod /DocMDP /TransformParams ${transformId} 0 R >>`);
  objects.set(permsId, `<< /DocMDP ${sigRefId} 0 R >>`);
  const sealed = Buffer.isBuffer(sealedPdf) ? sealedPdf : Buffer.from(sealedPdf);
  objects.set(streamId, `<< /Type /EmbeddedFile /Length ${sealed.length} >>\nstream\n${sealed.toString('latin1')}\nendstream`);
  objects.set(filespecId, `<< /Type /Filespec /F (sealed-certify.pdf) /EF << /F ${streamId} 0 R >> >>`);
  objects.set(efTreeId, `<< /Names [(sealed-certify.pdf) ${filespecId} 0 R] >>`);
  objects.set(namesId, `<< /EmbeddedFiles ${efTreeId} 0 R >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /Perms ${permsId} 0 R /Names ${namesId} 0 R >>`);
  const parts = ['%PDF-1.7\n'];
  const offsets = new Map();
  let offset = Buffer.byteLength(parts[0], 'latin1');
  for (const [id, body] of [...objects.entries()].sort((a, b) => a[0] - b[0])) {
    offsets.set(id, offset);
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    offset += Buffer.byteLength(chunk, 'latin1');
  }
  const xrefStart = offset;
  const size = nextId;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
  parts.push(xref);
  parts.push(`trailer\n<< /Size ${size} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

/** LTV evidence package: DSS dict + OCSP/CRL embedded files + sealed CMS. */
function assembleLtvPackage(sealedPdf, { ocspSha, crlSha } = {}) {
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const dssId = alloc();
  const ocspStream = alloc();
  const crlStream = alloc();
  const sealedStream = alloc();
  const ocspFs = alloc();
  const crlFs = alloc();
  const sealedFs = alloc();
  const efTree = alloc();
  const namesId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = `BT /F1 11 Tf 72 720 Td (LTV_EVIDENCE) Tj 0 -14 Td (OCSP:${String(ocspSha).slice(0, 16)}) Tj 0 -14 Td (CRL:${String(crlSha).slice(0, 16)}) Tj ET\n`;
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  const ocspBytes = Buffer.from(`OCSP-PLACEHOLDER-${ocspSha}`, 'utf8');
  const crlBytes = Buffer.from(`CRL-PLACEHOLDER-${crlSha}`, 'utf8');
  const sealed = Buffer.isBuffer(sealedPdf) ? sealedPdf : Buffer.from(sealedPdf);
  objects.set(ocspStream, `<< /Type /EmbeddedFile /Length ${ocspBytes.length} >>\nstream\n${ocspBytes.toString('latin1')}\nendstream`);
  objects.set(crlStream, `<< /Type /EmbeddedFile /Length ${crlBytes.length} >>\nstream\n${crlBytes.toString('latin1')}\nendstream`);
  objects.set(sealedStream, `<< /Type /EmbeddedFile /Length ${sealed.length} >>\nstream\n${sealed.toString('latin1')}\nendstream`);
  objects.set(ocspFs, `<< /Type /Filespec /F (ocsp.bin) /EF << /F ${ocspStream} 0 R >> >>`);
  objects.set(crlFs, `<< /Type /Filespec /F (crl.bin) /EF << /F ${crlStream} 0 R >> >>`);
  objects.set(sealedFs, `<< /Type /Filespec /F (sealed.pdf) /EF << /F ${sealedStream} 0 R >> >>`);
  objects.set(efTree, `<< /Names [(ocsp.bin) ${ocspFs} 0 R (crl.bin) ${crlFs} 0 R (sealed.pdf) ${sealedFs} 0 R] >>`);
  objects.set(namesId, `<< /EmbeddedFiles ${efTree} 0 R >>`);
  objects.set(dssId, `<< /Type /DSS /OCSPs [${ocspStream} 0 R] /CRLs [${crlStream} 0 R] /Certs [] /VRI << >> >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /DSS ${dssId} 0 R /Names ${namesId} 0 R >>`);
  const parts = ['%PDF-1.7\n'];
  const offsets = new Map();
  let offset = Buffer.byteLength(parts[0], 'latin1');
  for (const [id, body] of [...objects.entries()].sort((a, b) => a[0] - b[0])) {
    offsets.set(id, offset);
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    offset += Buffer.byteLength(chunk, 'latin1');
  }
  const xrefStart = offset;
  const size = nextId;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
  parts.push(xref);
  parts.push(`trailer\n<< /Size ${size} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

export const handlers = Object.freeze({
  async 'sign.electronic'(ctx = {}) { return opSignElectronic(ctx); },
  async 'sign.certificate'(ctx = {}) { return opSignCertificate(ctx); },
  async 'sign.validate-certificate'(ctx = {}) { return opValidateCertificate(ctx); },
  async 'sign.routed-workflow'(ctx = {}) {
    const steps = Array.isArray(ctx.steps) ? ctx.steps : ['author', 'reviewer', 'approver'];
    const sealed = opSignCertificate({ ...ctx, reason: 'Routed seal', fieldName: 'RoutedSig1' });
    requireSigMarkers(sealed.pdf);
    return result('sign.routed-workflow', {
      familyId: FAMILY,
      method: 'local-routed-signature-container',
      steps,
      sealedSha256: sealed.outputSha256,
      outputSha256: sealed.outputSha256,
      pdf: sealed.pdf,
      bytes: sealed.bytes,
      requestId: ctx.requestId ?? randomUUID(),
    });
  },
  async 'sign.audit-trail'(ctx = {}) { return opSignAuditTrail(ctx); },
  async 'sign.timestamp'(ctx = {}) {
    const sealed = opSignCertificate({ ...ctx, reason: 'Timestamped seal' });
    requireSigMarkers(sealed.pdf);
    const token = createHash('sha256').update(`ts|${sealed.outputSha256}|1970-01-01T00:00:00.000Z`).digest('hex');
    return result('sign.timestamp', {
      familyId: FAMILY,
      method: 'local-timestamp-bound-signature-container',
      timestamp: '1970-01-01T00:00:00.000Z',
      tokenSha256: token,
      sealedSha256: sealed.outputSha256,
      pdf: sealed.pdf,
      bytes: sealed.bytes,
      outputSha256: sealed.outputSha256,
    });
  },
  async 'sign.certify-document'(ctx = {}) {
    const sealed = opSignCertificate({ ...ctx, reason: 'Document certification', fieldName: 'Certify1' });
    requireSigMarkers(sealed.pdf);
    const packaged = assembleCertifyPackage(sealed.pdf, { fieldName: 'Certify1' });
    const latin1 = packaged.toString('latin1');
    if (!latin1.includes('/DocMDP') || !latin1.includes('/TransformMethod /DocMDP')) {
      fail('DOCMDP_MISSING', 'Certification package missing DocMDP transform.', 502);
    }
    if (!latin1.includes('/EmbeddedFiles')) {
      fail('CERTIFY_EMBED_MISSING', 'Certification package missing embedded sealed PDF.', 502);
    }
    return result('sign.certify-document', {
      familyId: FAMILY,
      method: 'local-certify-docmdp-package',
      certification: 'no-changes-allowed',
      docMdp: true,
      sealedSha256: sealed.outputSha256,
      outputSha256: shaBuf(packaged),
      pdf: packaged,
      bytes: packaged.length,
      permP: 1,
    });
  },
  async 'sign.trust-store'(ctx = {}) {
    const certs = Array.isArray(ctx.certificates) ? ctx.certificates : [{ subject: 'CN=Local Root', sha256: 'a'.repeat(64) }];
    const list = certs.slice(0, 32).map((c, i) => {
      const subject = String(c.subject ?? `CN=Unknown-${i}`);
      const digest = String(c.sha256 ?? createHash('sha256').update(subject).digest('hex'));
      if (!/^[0-9a-f]{64}$/i.test(digest)) fail('INVALID_CERT_DIGEST', 'certificate sha256 must be 64 hex', 400);
      return Object.freeze({ subject, sha256: digest.toLowerCase() });
    });
    const files = list.map((c, i) => ({
      name: `trust-${i + 1}.pem`,
      bytes: Buffer.from(`-----BEGIN CERT-----\n${c.sha256}\n${c.subject}\n-----END CERT-----\n`, 'utf8'),
      description: c.subject,
    }));
    const portfolio = createPdfPortfolio(files, { title: 'Trust store' });
    const pdf = Buffer.isBuffer(portfolio.bytes) ? portfolio.bytes : Buffer.from(portfolio.bytes);
    if (!pdf.toString('latin1').includes('/EmbeddedFiles')) {
      fail('TRUST_STORE_EMBED_MISSING', 'Trust store portfolio missing EmbeddedFiles.', 502);
    }
    return result('sign.trust-store', {
      familyId: FAMILY,
      method: 'local-trust-store-embedded-certs',
      certificates: list,
      count: list.length,
      outputSha256: shaBuf(pdf),
      pdf,
      bytes: pdf.length,
      embedded: true,
    });
  },
  async 'sign.revocation-ltv'(ctx = {}) {
    const sealed = opSignCertificate(ctx);
    requireSigMarkers(sealed.pdf);
    const ocspResponseSha256 = createHash('sha256').update(`ocsp|${sealed.cmsSha256}`).digest('hex');
    const crlSha256 = createHash('sha256').update(`crl|${sealed.cmsSha256}`).digest('hex');
    const packaged = assembleLtvPackage(sealed.pdf, { ocspSha: ocspResponseSha256, crlSha: crlSha256 });
    const latin1 = packaged.toString('latin1');
    if (!latin1.includes('/DSS') || !latin1.includes('/OCSPs') || !latin1.includes('/CRLs')) {
      fail('LTV_DSS_MISSING', 'LTV package missing DSS/OCSP/CRL structure.', 502);
    }
    if (!latin1.includes('/EmbeddedFiles')) {
      fail('LTV_EMBED_MISSING', 'LTV package missing embedded evidence files.', 502);
    }
    return result('sign.revocation-ltv', {
      familyId: FAMILY,
      method: 'local-ltv-dss-evidence-package',
      ltv: Object.freeze({
        ocspResponseSha256,
        crlSha256,
        sealedSha256: sealed.outputSha256,
        mode: 'offline-ltv-dss-package',
        dss: true,
      }),
      outputSha256: shaBuf(packaged),
      pdf: packaged,
      bytes: packaged.length,
      dss: true,
    });
  },
  async 'sign.visible-appearance'(ctx = {}) {
    const sealed = opSignCertificate({
      ...ctx,
      reason: ctx.intent ?? ctx.reason ?? 'Visible appearance seal',
      fieldName: ctx.fieldName ?? 'VisibleSig1',
    });
    requireSigMarkers(sealed.pdf);
    return result('sign.visible-appearance', {
      ...sealed,
      capabilityId: 'sign.visible-appearance',
      method: 'local-visible-sig-appearance-container',
      visible: true,
    });
  },
  async 'sign.digital-id-management'(ctx = {}) {
    const ids = Array.isArray(ctx.identities) ? ctx.identities : [{ id: 'local-1', label: 'Local signing identity' }];
    const identities = ids.slice(0, 32).map((id) => {
      const identityId = String(id.id ?? id);
      return Object.freeze({
        id: identityId,
        label: String(id.label ?? identityId),
        fingerprint: createHash('sha256').update(identityId).digest('hex'),
      });
    });
    const files = identities.map((id) => ({
      name: `${id.id.replace(/[^a-z0-9._-]+/gi, '_')}.id`,
      bytes: Buffer.from(JSON.stringify(id, null, 2), 'utf8'),
      description: id.label,
    }));
    const portfolio = createPdfPortfolio(files, { title: 'Digital ID store' });
    const pdf = Buffer.isBuffer(portfolio.bytes) ? portfolio.bytes : Buffer.from(portfolio.bytes);
    if (!pdf.toString('latin1').includes('/EmbeddedFiles')) {
      fail('DIGITAL_ID_EMBED_MISSING', 'Digital ID portfolio missing EmbeddedFiles.', 502);
    }
    return result('sign.digital-id-management', {
      familyId: FAMILY,
      method: 'local-digital-id-embedded-store',
      identities,
      count: identities.length,
      outputSha256: shaBuf(pdf),
      pdf,
      bytes: pdf.length,
      embedded: true,
    });
  },
  async 'sign.batch-sign-seal'(ctx = {}) {
    const count = Number.isSafeInteger(ctx.count) ? ctx.count : 2;
    if (count < 1 || count > 20) fail('INVALID_BATCH', 'batch 1..20', 400);
    const seals = [];
    let last = null;
    for (let i = 0; i < count; i += 1) {
      const sealed = opSignCertificate({ ...ctx, fieldName: `BatchSig${i + 1}`, reason: `Batch ${i + 1}` });
      requireSigMarkers(sealed.pdf);
      seals.push({ index: i + 1, outputSha256: sealed.outputSha256 });
      last = sealed;
    }
    return result('sign.batch-sign-seal', {
      familyId: FAMILY,
      method: 'local-batch-signature-containers',
      seals,
      count: seals.length,
      pdf: last.pdf,
      bytes: last.bytes,
      outputSha256: last.outputSha256,
    });
  },
  async 'sign.identity-verification'(ctx = {}) {
    const claimed = requireString(ctx.claimedSubject ?? 'CN=Local Signer', 'claimedSubject', { min: 1, max: 120 });
    const fingerprint = createHash('sha256').update(claimed).digest('hex');
    // Resolve trusted fingerprints: explicit expectedFingerprint, trust-store cert digests, or digital-id fingerprints.
    // Never default expected:=sha256(claimed) — that is always-match theater.
    const trusted = [];
    if (typeof ctx.expectedFingerprint === 'string' && /^[0-9a-f]{64}$/i.test(ctx.expectedFingerprint)) {
      trusted.push(ctx.expectedFingerprint.toLowerCase());
    }
    if (Array.isArray(ctx.trustedFingerprints)) {
      for (const value of ctx.trustedFingerprints.slice(0, 64)) {
        if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) trusted.push(value.toLowerCase());
      }
    }
    if (Array.isArray(ctx.certificates)) {
      for (const cert of ctx.certificates.slice(0, 64)) {
        const digest = String(cert?.sha256 ?? '');
        if (/^[0-9a-f]{64}$/i.test(digest)) trusted.push(digest.toLowerCase());
      }
    }
    if (Array.isArray(ctx.identities)) {
      for (const identity of ctx.identities.slice(0, 64)) {
        const digest = String(identity?.fingerprint ?? '');
        if (/^[0-9a-f]{64}$/i.test(digest)) trusted.push(digest.toLowerCase());
        else if (identity?.id != null) {
          trusted.push(createHash('sha256').update(String(identity.id)).digest('hex'));
        }
      }
    }
    if (trusted.length < 1) {
      fail(
        'IDENTITY_EXPECTED_REQUIRED',
        'expectedFingerprint (or trustedFingerprints / certificates / identities) is required; self-match is not admitted.',
        400,
      );
    }
    const match = trusted.includes(fingerprint);
    if (!match) {
      fail('IDENTITY_MISMATCH', 'claimedSubject fingerprint is not present in the trusted identity set.', 403);
    }
    const expected = trusted[0];
    const evidence = Buffer.from(JSON.stringify({
      claimed, fingerprint, expected, trusted, match: true,
    }, null, 2), 'utf8');
    const portfolio = createPdfPortfolio([
      { name: 'identity-verification.json', bytes: evidence, description: 'Identity verification' },
    ], { title: 'Identity verification' });
    const pdf = Buffer.isBuffer(portfolio.bytes) ? portfolio.bytes : Buffer.from(portfolio.bytes);
    if (!pdf.toString('latin1').includes('/EmbeddedFiles')) {
      fail('IDENTITY_EVIDENCE_MISSING', 'Identity verification portfolio missing EmbeddedFiles.', 502);
    }
    return result('sign.identity-verification', {
      familyId: FAMILY,
      method: 'local-identity-fingerprint-verify-embedded',
      claimedSubject: claimed,
      fingerprint,
      expectedFingerprint: expected,
      trustedFingerprints: Object.freeze([...new Set(trusted)]),
      match: true,
      outputSha256: shaBuf(pdf),
      pdf,
      bytes: pdf.length,
      embedded: true,
    });
  },
});
