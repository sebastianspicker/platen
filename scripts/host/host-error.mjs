export class HostError extends Error {
  constructor(code, message, status = 500, options = {}) {
    super(message, options);
    this.name = 'HostError';
    this.code = code;
    this.status = status;
  }
}

export function asHostError(error) {
  if (error instanceof HostError) return error;
  return new HostError('INTERNAL_ERROR', 'The local PDF host could not complete the request.', 500, { cause: error });
}
