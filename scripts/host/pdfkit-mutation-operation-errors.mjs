import { HostError } from './host-error.mjs';

export function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}
