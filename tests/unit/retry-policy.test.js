'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ERROR_STAGE, ExportError } = require('../../src/download/errors');
const { RetryPolicy } = require('../../src/download/retry-policy');

test('download URL 403 uses Golden special retry rule', () => {
  const policy = new RetryPolicy();
  const error = new ExportError(ERROR_STAGE.DOWNLOAD_URL_API, 'DOWNLOAD_URL_API_403', {
    httpStatus: 403,
  });
  assert.equal(policy.isRetryable(error, 1, 3), true);
  assert.equal(policy.isRetryable(error, 2, 3), false);
  assert.equal(policy.delayFor(error, 2), 3000);
});

test('content fetch 403 and transient server errors retry', () => {
  const policy = new RetryPolicy();
  assert.equal(policy.isRetryable(
    new ExportError(ERROR_STAGE.FILE_CONTENT_FETCH, 'FILE_CONTENT_FETCH_403', { httpStatus: 403 }),
    1,
    3
  ), true);
  assert.equal(policy.isRetryable(
    new ExportError(ERROR_STAGE.FILE_CONTENT_FETCH, 'FILE_CONTENT_FETCH_503', { httpStatus: 503 }),
    1,
    3
  ), true);
});

test('404 is not retryable', () => {
  const policy = new RetryPolicy();
  assert.equal(policy.isRetryable(
    new ExportError(ERROR_STAGE.FILE_CONTENT_FETCH, 'FILE_CONTENT_FETCH_404', { httpStatus: 404 }),
    1,
    3
  ), false);
});

