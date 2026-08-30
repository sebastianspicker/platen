import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const PDFKIT_REQUEST_FILENAME = 'request.json';
export const PDFKIT_MAX_REQUEST_BYTES = 8_192;

export function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function isDescendant(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== '' && pathFromParent !== '..' && !pathFromParent.startsWith(`..${String.fromCharCode(47)}`)
    && !isAbsolute(pathFromParent);
}

export async function validatedPrivateWorkspace(workspacePath, requestPath) {
  try {
    const rawWorkspace = absolutePath(workspacePath, 'workspacePath');
    const rawRequest = absolutePath(requestPath, 'requestPath');
    const [workspaceInfo, requestInfo] = await Promise.all([lstat(rawWorkspace), lstat(rawRequest)]);
    if (!workspaceInfo.isDirectory() || (workspaceInfo.mode & 0o077) !== 0) throw new TypeError('workspacePath must be a private directory');
    if (!requestInfo.isFile() || requestInfo.isSymbolicLink() || requestInfo.nlink !== 1
      || requestInfo.size > PDFKIT_MAX_REQUEST_BYTES || (requestInfo.mode & 0o077) !== 0
      || resolve(rawWorkspace, PDFKIT_REQUEST_FILENAME) !== rawRequest) {
      throw new TypeError('requestPath must be the private request.json file directly inside workspacePath');
    }
    const [workspace, request] = await Promise.all([realpath(rawWorkspace), realpath(rawRequest)]);
    if (!isDescendant(workspace, request) || resolve(workspace, PDFKIT_REQUEST_FILENAME) !== request) {
      throw new TypeError('requestPath must be the private request.json file directly inside workspacePath');
    }
    return Object.freeze({ workspace, request });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('workspacePath and requestPath must resolve to private workspace files');
  }
}

export async function validatedProtectionWorkspace(workspacePath) {
  try {
    const rawWorkspace = absolutePath(workspacePath, 'workspacePath');
    const information = await lstat(rawWorkspace);
    if (!information.isDirectory() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) {
      throw new TypeError('workspacePath must be a private directory');
    }
    return await realpath(rawWorkspace);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('workspacePath must resolve to a private directory');
  }
}

export function createPdfkitRequestPath(workspacePath) {
  return resolve(absolutePath(workspacePath, 'workspacePath'), PDFKIT_REQUEST_FILENAME);
}
