import test from 'node:test';
import {
  access,
  assert,
  convertSignatureContentsToDer,
  DocumentStore,
  EngineRegistry,
  execFileAsync,
  join,
  makeTextPdf,
  mkdir,
  mkdtemp,
  nativePackageRoot,
  PdfService,
  PopplerAdapter,
  projectRoot,
  readFile,
  Readable,
  rm,
  SignatureTrustAdapter,
  stageSignatureTrustHelper,
  tmpdir,
  verifyStagedSignatureTrustHelper,
  writeFile,
} from './support/host-pdf-service-fixture.js';

const requiredTools = [
  '/opt/homebrew/bin/openssl', '/opt/homebrew/bin/certutil',
  '/opt/homebrew/bin/pk12util', '/opt/homebrew/bin/pdfsig', '/usr/bin/swift',
];

async function installedToolchainAvailable() {
  try {
    await Promise.all(requiredTools.map((path) => access(path)));
    return true;
  } catch {
    return false;
  }
}

async function createSignedFixture(root) {
  const nssDirectory = join(root, 'fixture-nss');
  await mkdir(nssDirectory, { mode: 0o700 });
  const paths = {
    key: join(root, 'fixture-key.pem'),
    certificate: join(root, 'fixture-certificate.pem'),
    identity: join(root, 'fixture-identity.p12'),
    emptyPassword: join(root, 'empty-password.txt'),
    identityPassword: join(root, 'identity-password.txt'),
    input: join(root, 'fixture-input.pdf'),
    signed: join(root, 'fixture-signed.pdf'),
  };
  const marker = 'OFFLINE SIGNATURE INTEGRITY FIXTURE';
  await Promise.all([
    writeFile(paths.emptyPassword, '\n', { mode: 0o600 }),
    writeFile(paths.identityPassword, 'ephemeral-fixture-password\n', { mode: 0o600 }),
    writeFile(paths.input, makeTextPdf(marker), { mode: 0o600 }),
  ]);
  const commandOptions = {
    cwd: root, env: { LANG: 'C', LC_ALL: 'C' }, timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  };
  await execFileAsync('/opt/homebrew/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', paths.key, '-out', paths.certificate, '-days', '1',
    '-subj', '/CN=Platen Test/O=Local Fixture',
  ], commandOptions);
  await execFileAsync('/opt/homebrew/bin/openssl', [
    'pkcs12', '-export', '-out', paths.identity, '-inkey', paths.key,
    '-in', paths.certificate, '-name', 'Platen Test',
    '-passout', `file:${paths.identityPassword}`,
  ], commandOptions);
  await execFileAsync('/opt/homebrew/bin/certutil', [
    '-N', '-d', `sql:${nssDirectory}`, '-f', paths.emptyPassword,
  ], commandOptions);
  await execFileAsync('/opt/homebrew/bin/pk12util', [
    '-i', paths.identity, '-d', `sql:${nssDirectory}`, '-k', paths.emptyPassword,
    '-w', paths.identityPassword,
  ], commandOptions);
  await execFileAsync('/opt/homebrew/bin/pdfsig', [
    '-nssdir', `sql:${nssDirectory}`, '-add-signature', '-nick', 'Platen Test',
    paths.input, paths.signed,
  ], commandOptions);
  const signedBytes = await readFile(paths.signed);
  const derSignedBytes = await convertSignatureContentsToDer(
    signedBytes, root, commandOptions,
  );
  const markerOffset = signedBytes.indexOf(Buffer.from(marker));
  assert.notEqual(
    markerOffset, -1,
    'the signed fixture must retain the source marker for deterministic alteration',
  );
  const alteredBytes = Buffer.from(signedBytes);
  alteredBytes[markerOffset] ^= 1;
  return {
    alteredBytes,
    commandOptions,
    derSignedBytes,
    priorRevisionBytes: Buffer.concat([signedBytes, Buffer.from('\n% unsigned incremental tail\n')]),
    signedBytes,
  };
}

async function createSignatureService(root, commandOptions) {
  const store = await new DocumentStore({ root: join(root, 'store') }).initialize();
  const registry = new EngineRegistry();
  await execFileAsync('/usr/bin/swift', [
    'build', '-c', 'release', '--product', 'pdf-signature-trust',
    '--package-path', nativePackageRoot,
  ], commandOptions);
  const stagedTrust = await stageSignatureTrustHelper({ root: projectRoot, sessionRoot: root });
  assert.equal(stagedTrust.available, true);
  const trust = new SignatureTrustAdapter({
    executable: stagedTrust.executable,
    expectedSha256: stagedTrust.sha256,
    verifyExecutable: verifyStagedSignatureTrustHelper,
  });
  return {
    service: new PdfService({
      store, registry, adapter: new PopplerAdapter({ registry }), signatureTrustAdapter: trust,
    }),
    store,
  };
}

async function inspectFixtureVariants(store, service, bytes) {
  const documents = await Promise.all([
    ['signed.pdf', bytes.signedBytes], ['der-signed.pdf', bytes.derSignedBytes],
    ['altered.pdf', bytes.alteredBytes], ['prior-revision.pdf', bytes.priorRevisionBytes],
  ].map(([displayName, content]) => store.createDocument({
    stream: Readable.from([content]), displayName,
  })));
  const [signed, derSigned, altered, priorRevision] = documents;
  return Promise.all([
    service.verifySignatures(signed.id), service.verifySignatures(derSigned.id),
    service.verifySignatures(altered.id), service.verifySignatures(priorRevision.id),
  ]);
}

function assertVerifiedEvidence(evidence) {
  assert.equal(evidence.status, 'valid');
  assert.equal(evidence.cmsCrossCheck.status, 'verified');
  assert.equal(evidence.overallCurrentDocumentStatus, 'valid');
  assert.equal(evidence.certificateChainSummary, 'all-fail');
  assert.equal(evidence.signatures[0].certificateChain.status, 'fails');
  assert.match(
    evidence.signatures[0].certificateChain.reason,
    /^(not-trusted|policy-failure)$/u,
  );
  assert.equal(evidence.signatures[0].identityVerified, false);
}

test('installed pdfsig and macOS Security keep integrity, coverage, and certificate paths separate', { timeout: 60_000 }, async (context) => {
  if (!(await installedToolchainAvailable())) {
    context.skip('The local OpenSSL, NSS, and Poppler signature fixture toolchain is not installed.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-signature-test-'));
  let store = null;
  context.after(async () => {
    if (store) await store.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const bytes = await createSignedFixture(root);
  const configured = await createSignatureService(root, bytes.commandOptions);
  store = configured.store;
  const [valid, der, invalid, prior] = await inspectFixtureVariants(
    store, configured.service, bytes,
  );
  assertVerifiedEvidence(valid);
  assert.equal(valid.signatures[0].integrity, 'valid');
  assert.equal(valid.signatures[0].documentCoverage, 'full');
  assert.equal(valid.schemaVersion, 2);
  assertVerifiedEvidence(der);
  assert.equal(der.certificateEvaluation.certificateNetworkFetchAllowed, false);
  assert.equal(der.signatures[0].revocation, 'not-checked');
  assert.equal(der.signatures[0].timestamp, 'not-checked');
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.signatures[0].integrity, 'invalid');
  assert.equal(invalid.currentDocumentStatus, 'invalid');
  assert.equal(invalid.schemaVersion, 1);
  assert.equal('cmsCrossCheck' in invalid, false,
    'invalid Poppler evidence must not trigger CMS extraction or native enrichment');
  assert.equal(prior.status, 'valid');
  assert.equal(prior.signatures[0].documentCoverage, 'prior-revision');
  assert.equal(prior.cmsCrossCheck.status, 'verified');
  assert.equal(prior.overallCurrentDocumentStatus, 'modified-after-signing');
  for (const evidence of [valid, der, invalid, prior]) {
    assert.equal('raw' in evidence, false);
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /cmsSha256|input\.pdf\.sig|fixture-signed\.pdf|der-signed\.pdf|fixture-key\.pem|fixture-nss|fixture-cms/,
    );
  }
});
