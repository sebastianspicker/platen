import { LocalOperationError } from '../../../contracts/errors.js';

export class HostError extends LocalOperationError {
  constructor(code, message, status = 500, options = {}) {
    super(code, message, status, options);
    this.name = 'HostError';
  }
}

export function asHostError(error) {
  if (error instanceof HostError) return error;
  return new HostError('INTERNAL_ERROR', 'The local PDF host could not complete the request.', 500, { cause: error });
}
