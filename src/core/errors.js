export class PlatenError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'PlatenError';
    this.code = code;
  }
}

export function platenError(code, message, cause) {
  if (cause instanceof PlatenError) return cause;
  return new PlatenError(code, message, cause ? { cause } : undefined);
}
