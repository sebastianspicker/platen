const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_EVENTS = 500;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function revision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalid() {
  throw new TypeError('The local host returned an invalid review notification result.');
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function copyTree(value) {
  if (Array.isArray(value)) return value.map(copyTree);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Object.keys(value)) copy[key] = copyTree(value[key]);
  return copy;
}

function requestValid(value, { read = false } = {}) {
  const hasActor = !read && value && Object.hasOwn(value, 'actorId');
  const keys = read ? ['sourceSha256', 'expectedRevision', 'notificationId']
    : (hasActor ? ['sourceSha256', 'expectedRevision', 'actorId'] : ['sourceSha256', 'expectedRevision']);
  if (!exact(value, keys) || !SHA256.test(value.sourceSha256 ?? '') || !revision(value.expectedRevision)) return false;
  return read
    ? ID.test(value.notificationId ?? '')
    : (!hasActor || REVIEWER.test(value.actorId));
}

export function validateReviewNotificationResult(result, {
  sourceSha256, expectedRevision, operation = 'generate', request = null,
} = {}) {
  const read = operation === 'markRead';
  const expectedRequest = request ?? (read
    ? { sourceSha256, expectedRevision, notificationId: result?.notificationId }
    : { sourceSha256, expectedRevision });
  if (!requestValid(expectedRequest, { read }) || expectedRequest.sourceSha256 !== sourceSha256
    || expectedRequest.expectedRevision !== expectedRevision) invalid();
  const keys = read ? ['changed', 'idempotent', 'revision', 'sourceSha256'] : ['applied', 'idempotent', 'revision', 'sourceSha256'];
  if (!exact(result, keys) || result.sourceSha256 !== sourceSha256 || !revision(result.revision)
    || result.revision < expectedRevision || typeof result.idempotent !== 'boolean') invalid();
  if (read) {
    if (typeof result.changed !== 'boolean' || result.idempotent !== !result.changed) invalid();
  } else if (!Number.isSafeInteger(result.applied) || result.applied < 0 || result.applied > MAX_EVENTS
    || result.idempotent !== (result.applied === 0)) invalid();
  return frozen(copyTree(result));
}
