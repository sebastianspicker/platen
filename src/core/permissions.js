import { PlatenError } from './errors.js';

export const PERMISSIONS = Object.freeze([
  'document.metadata',
  'document.read.bytes',
  'document.modify',
  'document.export',
  'ui.panel',
  'ui.toolbar',
  'storage.local',
]);

export const METHOD_PERMISSIONS = Object.freeze({
  'document.getMetadata': ['document.metadata'],
  'document.readRange': ['document.read.bytes'],
  'document.createRevision': ['document.modify'],
  'document.exportRevision': ['document.export'],
  'ui.openPanel': ['ui.panel'],
  'ui.addToolbarAction': ['ui.toolbar'],
  'storage.get': ['storage.local'],
  'storage.set': ['storage.local'],
});

const permissionSet = new Set(PERMISSIONS);

export function validatePermissionRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new PlatenError('MANIFEST_INVALID', 'Permission requests must be objects.');
  }
  const allowedKeys = new Set(['name', 'reason']);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) {
      throw new PlatenError('MANIFEST_INVALID', `Unknown permission field: ${key}.`);
    }
  }
  if (!permissionSet.has(request.name)) {
    throw new PlatenError('MANIFEST_INVALID', `Unknown permission: ${request.name}.`);
  }
  if (typeof request.reason !== 'string' || request.reason.trim().length < 8) {
    throw new PlatenError('MANIFEST_INVALID', `Permission ${request.name} needs a meaningful reason.`);
  }
  return true;
}

export function assertMethodPermission(method, grantedPermissions) {
  const required = METHOD_PERMISSIONS[method];
  if (!required) {
    throw new PlatenError('REQUEST_INVALID', `Unknown plugin method: ${method}.`);
  }
  const granted = new Set(grantedPermissions);
  if (!required.every((permission) => granted.has(permission))) {
    throw new PlatenError('PERMISSION_DENIED', `Permission denied for ${method}.`);
  }
  return true;
}
