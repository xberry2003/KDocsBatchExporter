'use strict';

const { ERROR_STAGE } = require('./errors');

class RetryPolicy {
  constructor(options = {}) {
    this.delays = options.delays || [0, 2000, 5000];
    this.downloadUrl403Delay = options.downloadUrl403Delay || 3000;
  }

  isRetryable(error, attempt, maxAttempts = this.delays.length) {
    if (attempt >= maxAttempts) return false;
    const stage = error?.stage || error?.details?.stage || ERROR_STAGE.UNKNOWN;
    const status = error?.httpStatus || error?.details?.httpStatus || error?.details?.downloadApiStatus || null;
    const message = String(error?.message || error || '').toUpperCase();

    if (stage === ERROR_STAGE.DOWNLOAD_URL_API && status === 403) return attempt < 2;
    if (stage === ERROR_STAGE.FILE_CONTENT_FETCH && status === 403) return true;
    if (status === 404) return false;
    if (status === 429 || [500, 502, 503, 504].includes(status)) return true;
    if (stage === ERROR_STAGE.STREAM_READ) return true;
    return /NETWORK|FAILED TO FETCH|TYPEERROR|LOAD FAILED/.test(message);
  }

  delayFor(error, attempt) {
    const stage = error?.stage || error?.details?.stage || ERROR_STAGE.UNKNOWN;
    const status = error?.httpStatus || error?.details?.httpStatus || error?.details?.downloadApiStatus || null;
    if (stage === ERROR_STAGE.DOWNLOAD_URL_API && status === 403) {
      return this.downloadUrl403Delay;
    }
    return this.delays[Math.max(0, attempt - 1)] || 0;
  }
}

module.exports = { RetryPolicy };

