import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { HostError } from './host-error.mjs';

const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const MIN_PROFILE_BYTES = 132;
const MAX_TAGS = 1_024;

function fail(code, message, status = 503, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function childPath(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fourCc(bytes, offset) {
  return bytes.subarray(offset, offset + 4).toString('latin1');
}

function profileDescription(bytes, tags) {
  const entry = tags.get('desc');
  if (!entry || entry.size < 12 || fourCc(bytes, entry.offset) !== 'desc') return null;
  const length = bytes.readUInt32BE(entry.offset + 8);
  if (length < 2 || length > 256 || entry.offset + 12 + length > entry.offset + entry.size) return null;
  const value = bytes.subarray(entry.offset + 12, entry.offset + 12 + length - 1).toString('latin1');
  return /^[\x20-\x7e]{1,255}$/u.test(value) ? value : null;
}

/** Validates the bounded structural envelope required for a local CMYK output profile. */
export function inspectCmykOutputProfile(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_PROFILE_BYTES || bytes.length > MAX_PROFILE_BYTES) {
    fail('ICC_PROFILE_INVALID', 'The bundled CMYK profile has an invalid size.');
  }
  if (bytes.readUInt32BE(0) !== bytes.length || fourCc(bytes, 36) !== 'acsp') {
    fail('ICC_PROFILE_INVALID', 'The bundled CMYK profile header is invalid.');
  }
  const deviceClass = fourCc(bytes, 12);
  const colorSpace = fourCc(bytes, 16);
  const connectionSpace = fourCc(bytes, 20);
  const renderingIntent = bytes.readUInt32BE(64);
  const majorVersion = bytes[8];
  if (deviceClass !== 'prtr' || colorSpace !== 'CMYK' || !['Lab ', 'XYZ '].includes(connectionSpace)
    || renderingIntent > 3 || majorVersion < 2 || majorVersion > 4) {
    fail('ICC_PROFILE_INVALID', 'The bundled profile is not a supported CMYK printer output profile.');
  }
  const tagCount = bytes.readUInt32BE(128);
  const tableEnd = 132 + tagCount * 12;
  if (tagCount < 1 || tagCount > MAX_TAGS || tableEnd > bytes.length) {
    fail('ICC_PROFILE_INVALID', 'The bundled CMYK profile tag table is invalid.');
  }
  const tags = new Map();
  for (let index = 0; index < tagCount; index += 1) {
    const at = 132 + index * 12;
    const signature = fourCc(bytes, at);
    const offset = bytes.readUInt32BE(at + 4);
    const size = bytes.readUInt32BE(at + 8);
    if (!/^[\x20-\x7e]{4}$/u.test(signature) || tags.has(signature)
      || size < 8 || offset < tableEnd || offset + size > bytes.length || offset + size < offset) {
      fail('ICC_PROFILE_INVALID', 'The bundled CMYK profile contains an invalid tag record.');
    }
    tags.set(signature, Object.freeze({ offset, size }));
  }
  const version = `${majorVersion}.${bytes[9] >> 4}.${bytes[9] & 0x0f}`;
  return Object.freeze({
    id: 'ghostscript-default-cmyk',
    description: profileDescription(bytes, tags) ?? 'Ghostscript bundled default CMYK profile',
    version,
    deviceClass: 'output',
    colorSpace: 'CMYK',
    connectionSpace: connectionSpace.trim(),
    renderingIntent,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    tagCount,
  });
}

async function readProfile(path) {
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n
    || initial.size < BigInt(MIN_PROFILE_BYTES) || initial.size > BigInt(MAX_PROFILE_BYTES)) {
    fail('ICC_PROFILE_UNAVAILABLE', 'The Ghostscript CMYK output profile is unavailable.');
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(initial, opened)) fail('ICC_PROFILE_UNAVAILABLE', 'The Ghostscript CMYK profile changed before it could be staged.');
    const bytes = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead < 1) fail('ICC_PROFILE_UNAVAILABLE', 'The Ghostscript CMYK profile was truncated while reading.');
      position += bytesRead;
    }
    if (!sameFile(opened, await handle.stat({ bigint: true }))) {
      fail('ICC_PROFILE_UNAVAILABLE', 'The Ghostscript CMYK profile changed while it was being staged.');
    }
    return Object.freeze({ bytes, descriptor: inspectCmykOutputProfile(bytes) });
  } finally {
    await handle.close();
  }
}

export class GhostscriptIccProfileProvider {
  #registry;

  constructor({ registry } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('GhostscriptIccProfileProvider requires an EngineRegistry-compatible registry.');
    this.#registry = registry;
  }

  async stageDefaultCmyk(workspace) {
    if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0')) {
      throw new TypeError('workspace must be an absolute path without NUL bytes.');
    }
    try {
      const engine = await this.#registry.probe('gs');
      const executable = await realpath(engine.executable);
      const installation = resolve(dirname(executable), '..');
      const profilePath = resolve(installation, 'share', 'ghostscript', 'iccprofiles', 'default_cmyk.icc');
      if (!childPath(installation, profilePath) || await realpath(profilePath) !== profilePath) {
        fail('ICC_PROFILE_UNAVAILABLE', 'The Ghostscript CMYK profile path is not an immutable installation component.');
      }
      const { bytes, descriptor } = await readProfile(profilePath);
      const outputPath = join(resolve(workspace), 'default-cmyk.icc');
      if (!childPath(resolve(workspace), outputPath)) throw new TypeError('profile destination must remain inside workspace.');
      const output = await open(outputPath, 'wx', 0o400);
      try {
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await output.close();
      }
      await chmod(outputPath, 0o400);
      const staged = await readProfile(outputPath);
      if (staged.descriptor.sha256 !== descriptor.sha256) {
        fail('ICC_PROFILE_UNAVAILABLE', 'The staged Ghostscript CMYK profile did not match its installation source.');
      }
      return Object.freeze({
        path: outputPath,
        engine: Object.freeze({ name: 'Ghostscript', version: engine.version }),
        descriptor,
      });
    } catch (error) {
      if (error instanceof HostError || error instanceof TypeError) throw error;
      fail('ICC_PROFILE_UNAVAILABLE', 'The Ghostscript CMYK output profile could not be staged safely.', 503, error);
    }
  }
}
