/**
 * Exception hierarchy for the Houndsight SDK.
 *
 * All errors thrown by this package inherit from {@link HoundsightError} so
 * callers can catch SDK failures in one place without catching unrelated
 * errors from user code or third-party libraries.
 */

export class HoundsightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the SDK is misconfigured (e.g. missing API key). */
export class ConfigurationError extends HoundsightError {}

/** Raised when the background transport fails irrecoverably. */
export class TransportError extends HoundsightError {}

/** Raised when a leash gate is invoked with invalid arguments. */
export class LeashError extends HoundsightError {}

/** Raised when an instrumentation wrapper cannot be applied. */
export class InstrumentationError extends HoundsightError {}
