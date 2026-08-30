export class PlatenError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'PlatenError';
    this.code = code;
  }
}

export class LocalOperationError extends PlatenError {
  constructor(code, message, status = 500, options = {}) {
    super(code, message, options);
    this.name = 'LocalOperationError';
    this.status = status;
  }
}

export function platenError(code, message, cause) {
  if (cause instanceof PlatenError) return cause;
  return new PlatenError(code, message, cause ? { cause } : undefined);
}
