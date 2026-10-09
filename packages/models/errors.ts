import { MDBError } from '../core/types.js';

/** Provider failure with a fixed, sanitized message. Never carries prompts, response bodies, headers or credentials. */
export class ProviderError extends MDBError {
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) { super('PROVIDER_ERROR', message); this.name = 'ProviderError'; }
}
export class CancelledError extends MDBError { constructor() { super('CANCELLED', 'Model call cancelled'); this.name = 'CancelledError'; } }
