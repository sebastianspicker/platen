export function newAecId(cryptoApi, prefix) {
  if (typeof cryptoApi?.randomUUID !== 'function') {
    throw new Error('Secure local identifiers are unavailable in this browser.');
  }
  return `${prefix}-${cryptoApi.randomUUID()}`;
}
