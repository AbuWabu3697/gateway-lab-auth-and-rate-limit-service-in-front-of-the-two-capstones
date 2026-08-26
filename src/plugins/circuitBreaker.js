/**
 * Per-upstream circuit breaker using a sliding window of the last N responses.
 *
 * States:
 *   closed  — normal operation; all requests forwarded
 *   open    — upstream is failing; requests rejected with 503
 *   half-open — one probe request allowed through to test recovery
 *
 * The breaker opens when the 5xx error rate across the last cbWindowSize
 * responses exceeds cbErrorThreshold (default: 50% over 10 requests).
 * After cbOpenDurationMs the breaker moves to half-open and allows a
 * single probe. A 2xx probe closes the breaker; another 5xx re-opens it.
 */

const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {number} opts.windowSize   Number of responses tracked
   * @param {number} opts.errorThreshold  Fraction (0-1) of 5xx that trips the breaker
   * @param {number} opts.openDurationMs  Ms to stay open before moving to half-open
   * @param {string} opts.name  Label for log messages
   */
  constructor({ windowSize, errorThreshold, openDurationMs, name }) {
    this.windowSize = windowSize;
    this.errorThreshold = errorThreshold;
    this.openDurationMs = openDurationMs;
    this.name = name;

    this._state = STATE.CLOSED;
    this._window = []; // boolean[] — true means 5xx
    this._openedAt = null;
  }

  get state() {
    return this._state;
  }

  /** Call after receiving an upstream response. */
  record(is5xx) {
    this._window.push(is5xx);
    if (this._window.length > this.windowSize) {
      this._window.shift();
    }

    if (this._state === STATE.HALF_OPEN) {
      this._state = is5xx ? STATE.OPEN : STATE.CLOSED;
      if (is5xx) this._openedAt = Date.now();
      return;
    }

    if (this._state === STATE.CLOSED && this._window.length === this.windowSize) {
      const errorRate = this._window.filter(Boolean).length / this.windowSize;
      if (errorRate > this.errorThreshold) {
        this._state = STATE.OPEN;
        this._openedAt = Date.now();
      }
    }
  }

  /**
   * Returns true if the request should be allowed through.
   * Transitions OPEN → HALF_OPEN after openDurationMs.
   */
  allowRequest() {
    if (this._state === STATE.CLOSED) return true;

    if (this._state === STATE.OPEN) {
      const elapsed = Date.now() - this._openedAt;
      if (elapsed >= this.openDurationMs) {
        this._state = STATE.HALF_OPEN;
        return true; // single probe
      }
      return false;
    }

    // HALF_OPEN — only one probe is in flight; block subsequent requests
    return false;
  }
}
