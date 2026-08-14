import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PluginDocumentHandleStore } from '../scripts/host/plugin-document-handles.mjs';
import { PluginGrantStore } from '../scripts/host/plugin-grants.mjs';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const binding = Object.freeze({
  pluginId: 'org.platen.example',
  version: '1.2.3',
  packageHash: 'a'.repeat(64),
  activationId: 'activation_1234567890',
});
const operationId = 'operation_1234567890';
const declaredPermissions = ['document.metadata', 'document.read.bytes'];
const permissions = [...declaredPermissions];
const methods = ['document.getMetadata', 'document.readRange'];

function grantAuthority(documents, clock = () => 1_000, activation = {}) {
  return new PluginGrantStore({
    clock,
    resolveActivation: async () => ({
      id: binding.pluginId,
      version: binding.version,
      digest: binding.packageHash,
      manifest: { permissions: declaredPermissions.map((name) => ({ name })) },
      ...activation,
    }),
    resolveDocument: async (documentId) => documents.getDocument(documentId),
  });
}

async function fixture(context, { clock = () => 1_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pdf-plugin-grant-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const document = await documents.createDocument({ stream: Readable.from([pdf]), displayName: 'private.pdf' });
  const grants = grantAuthority(documents, clock);
  const grant = await grants.issue({
    binding,
    documentId: document.id,
    operationId,
    permissions,
    methods,
  });
  const handles = new PluginDocumentHandleStore({ documents, grants, clock });
  const issued = handles.issue({
    grantId: grant.grantId,
    binding,
    documentId: document.id,
    operationId,
    methods,
  });
  return { documents, document, grants, grant, handles, issued };
}

test('explicit grants stay within the signed local-only permission ceiling', async (context) => {
  const { grants, document, documents } = await fixture(context);
  const limitedGrants = grantAuthority(documents, () => 1_000, {
    manifest: { permissions: [{ name: 'document.metadata' }] },
  });
  await assert.rejects(limitedGrants.issue({
    binding,
    documentId: document.id,
    operationId,
    permissions: ['document.read.bytes'],
    methods: ['document.readRange'],
  }), { code: 'PLUGIN_PERMISSION_UNDECLARED' });
  await assert.rejects(grants.issue({
    binding,
    documentId: document.id,
    operationId,
    permissions: ['network.fetch'],
    methods: ['network.fetch'],
  }), { code: 'PLUGIN_PERMISSION_FORBIDDEN' });
});

test('opaque document handles expose bounded metadata and ranges without identifiers or paths', async (context) => {
  const { documents, document, handles, issued } = await fixture(context);
  const sourceBefore = readFileSync(documents.getSourcePath(document.id));
  assert.match(issued.handle, /^pdfh_[0-9a-f]{64}$/);
  assert.equal(issued.handle.includes(document.id), false);

  const requestContext = { binding, operationId };
  const metadata = await handles.getMetadata(issued.handle, requestContext);
  assert.equal(metadata.displayName, 'private.pdf');
  assert.equal(metadata.sha256, document.sha256);
  assert.equal(Object.hasOwn(metadata, 'id'), false);
  assert.equal(Object.hasOwn(metadata, 'operation'), false);
  assert.equal(JSON.stringify(metadata).includes(documents.root), false);

  const bytes = await handles.readRange(issued.handle, { offset: 0, length: 8 }, requestContext);
  assert.deepEqual(bytes, pdf.subarray(0, 8));
  assert.deepEqual(readFileSync(documents.getSourcePath(document.id)), sourceBefore);
});

test('grant and handle bindings reject cross-plugin, cross-activation, expiry, and revocation', async (context) => {
  let now = 1_000;
  const { grants, grant, handles, issued } = await fixture(context, { clock: () => now });
  await assert.rejects(handles.getMetadata(issued.handle, {
    binding: { ...binding, pluginId: 'org.platen.attacker' }, operationId,
  }), { code: 'PLUGIN_HANDLE_BINDING_MISMATCH' });
  await assert.rejects(handles.getMetadata(issued.handle, {
    binding: { ...binding, activationId: 'activation_attacker_1234' }, operationId,
  }), { code: 'PLUGIN_HANDLE_BINDING_MISMATCH' });
  grants.revoke(grant.grantId);
  await assert.rejects(handles.getMetadata(issued.handle, { binding, operationId }), { code: 'PLUGIN_GRANT_REVOKED' });

  const second = await fixture(context, { clock: () => now });
  now += 5 * 60_000;
  await assert.rejects(second.handles.getMetadata(second.issued.handle, { binding, operationId }), {
    code: 'PLUGIN_HANDLE_EXPIRED',
  });
});

test('handle and grant usage and byte quotas are enforced before reads', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-plugin-quota-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const document = await documents.createDocument({ stream: Readable.from([pdf]), displayName: 'quota.pdf' });
  const grants = grantAuthority(documents);
  const grant = await grants.issue({
    binding,
    documentId: document.id,
    operationId,
    permissions,
    methods,
    usageLimit: 2,
  });
  const handles = new PluginDocumentHandleStore({ documents, grants, clock: () => 1_000, maxReadBytes: 16 });
  const issued = handles.issue({
    grantId: grant.grantId, binding, documentId: document.id, operationId,
    methods: ['document.readRange'], usageLimit: 2, byteLimit: 8,
  });
  await handles.readRange(issued.handle, { offset: 0, length: 8 }, { binding, operationId });
  await assert.rejects(
    handles.readRange(issued.handle, { offset: 0, length: 1 }, { binding, operationId }),
    { code: 'PLUGIN_HANDLE_BYTE_QUOTA' },
  );
  await assert.rejects(
    handles.readRange(issued.handle, { offset: 0, length: 17 }, { binding, operationId }),
    TypeError,
  );
});

test('grant issuance resolves verified activation and document authority rather than caller declarations', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-plugin-authority-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const document = await documents.createDocument({ stream: Readable.from([pdf]), displayName: 'authority.pdf' });
  const grants = grantAuthority(documents, () => 1_000, { digest: 'f'.repeat(64) });
  await assert.rejects(grants.issue({
    binding, documentId: document.id, operationId, permissions, methods,
  }), { code: 'PLUGIN_ACTIVATION_BINDING_MISMATCH' });
});

test('parallel range reads atomically reserve the handle byte quota', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-plugin-race-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const document = await documents.createDocument({ stream: Readable.from([pdf]), displayName: 'race.pdf' });
  const grants = grantAuthority(documents);
  const grant = await grants.issue({
    binding, documentId: document.id, operationId, permissions, methods, usageLimit: 4,
  });
  const handles = new PluginDocumentHandleStore({ documents, grants, clock: () => 1_000, maxReadBytes: 16 });
  const issued = handles.issue({
    grantId: grant.grantId, binding, documentId: document.id, operationId,
    methods: ['document.readRange'], usageLimit: 4, byteLimit: 8,
  });
  const outcomes = await Promise.allSettled([
    handles.readRange(issued.handle, { offset: 0, length: 8 }, { binding, operationId }),
    handles.readRange(issued.handle, { offset: 0, length: 8 }, { binding, operationId }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = outcomes.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'PLUGIN_HANDLE_BYTE_QUOTA');
});

test('descriptor-bound reads reject symbolic and hard-linked sources', async (context) => {
  const symlinked = await fixture(context);
  const symlinkSource = symlinked.documents.getSourcePath(symlinked.document.id);
  renameSync(symlinkSource, `${symlinkSource}.original`);
  symlinkSync('source.pdf.original', symlinkSource);
  await assert.rejects(
    symlinked.handles.readRange(symlinked.issued.handle, { offset: 0, length: 8 }, { binding, operationId }),
    { code: 'PLUGIN_SOURCE_CHANGED' },
  );

  const linked = await fixture(context);
  const linkedSource = linked.documents.getSourcePath(linked.document.id);
  linkSync(linkedSource, `${linkedSource}.hardlink`);
  await assert.rejects(
    linked.handles.readRange(linked.issued.handle, { offset: 0, length: 8 }, { binding, operationId }),
    { code: 'PLUGIN_SOURCE_CHANGED' },
  );
});

test('descriptor-bound reads reject a source path swapped after store verification', async (context) => {
  const { documents, document, grants, grant } = await fixture(context);
  const sourcePath = documents.getSourcePath(document.id);
  let swapped = false;
  const handles = new PluginDocumentHandleStore({
    documents: {
      getDocument: (id) => documents.getDocument(id),
      verifySource: (id) => documents.verifySource(id),
      getSourcePath(id) {
        if (!swapped) {
          swapped = true;
          renameSync(sourcePath, `${sourcePath}.verified`);
          writeFileSync(sourcePath, Buffer.alloc(pdf.length, 0x58), { mode: 0o600 });
          chmodSync(sourcePath, 0o600);
        }
        return documents.getSourcePath(id);
      },
    },
    grants,
    clock: () => 1_000,
  });
  const issued = handles.issue({
    grantId: grant.grantId, binding, documentId: document.id, operationId, methods,
  });
  await assert.rejects(
    handles.readRange(issued.handle, { offset: 0, length: 8 }, { binding, operationId }),
    { code: 'PLUGIN_SOURCE_CHANGED' },
  );
  assert.equal(swapped, true);
});
