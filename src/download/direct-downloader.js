'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ERROR_STAGE, ExportError } = require('./errors');
const { RetryPolicy } = require('./retry-policy');
const { validateBuffer } = require('./validators');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validationTypeFor(item = {}) {
  const name = String(item.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.pptx')) return 'pptx';
  if (name.endsWith('.ppt')) return 'ppt';
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.xls')) return 'xls';
  return 'other';
}

class DirectDownloader {
  constructor(options = {}) {
    if (!options.apiClient) throw new Error('DirectDownloader requires apiClient');
    this.apiClient = options.apiClient;
    this.retryPolicy = options.retryPolicy || new RetryPolicy(options.retry || {});
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('Fetch implementation is required');
    this.maxAttempts = options.maxAttempts || 3;
  }

  async fetchContent(downloadInfo) {
    let response;
    try {
      response = await this.fetchImpl(downloadInfo.url, {
        headers: {
          Accept: 'application/octet-stream,*/*',
          Cookie: this.apiClient.sessionStore.getCookie(),
        },
      });
    } catch (cause) {
      throw new ExportError(ERROR_STAGE.FILE_CONTENT_FETCH, 'FILE_CONTENT_FETCH_ERROR', {
        downloadApiStatus: downloadInfo.status,
        downloadUrlSummary: downloadInfo.urlSummary,
      }, cause);
    }

    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0) || null;
    if (!response.ok) {
      throw new ExportError(ERROR_STAGE.FILE_CONTENT_FETCH, `FILE_CONTENT_FETCH_${response.status}`, {
        httpStatus: response.status,
        downloadApiStatus: downloadInfo.status,
        downloadUrlSummary: downloadInfo.urlSummary,
        contentType,
        contentLength,
      });
    }

    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw new ExportError(ERROR_STAGE.STREAM_READ, 'STREAM_READ_ERROR', {
        httpStatus: response.status,
        downloadApiStatus: downloadInfo.status,
        downloadUrlSummary: downloadInfo.urlSummary,
        contentType,
        contentLength,
      }, cause);
    }
    return { buffer, contentType, contentLength, httpStatus: response.status };
  }

  async download(item, outputPath, options = {}) {
    const startedAt = new Date().toISOString();
    const maxAttempts = options.maxAttempts || this.maxAttempts;
    const attempts = [];
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        const delay = this.retryPolicy.delayFor(lastError, attempt);
        if (delay > 0) await sleep(delay);
      }

      let downloadInfo = null;
      try {
        downloadInfo = await this.apiClient.getDownloadUrlInfo(item.groupId, item.id);
        const content = await this.fetchContent(downloadInfo);
        const validationType = options.validationType || validationTypeFor(item);
        const validation = validateBuffer(content.buffer, validationType);
        if (!validation.pass) {
          throw new ExportError(ERROR_STAGE.VALIDATION, 'VALIDATION_FAILED', {
            validation,
            contentType: content.contentType,
            contentLength: content.contentLength,
            downloadApiStatus: downloadInfo.status,
            downloadUrlSummary: downloadInfo.urlSummary,
          });
        }

        try {
          await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        } catch (cause) {
          throw new ExportError(ERROR_STAGE.LOCAL_DIRECTORY, 'LOCAL_DIRECTORY_ERROR', {
            localPath: outputPath,
          }, cause);
        }

        const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
        try {
          await fs.promises.writeFile(tempPath, content.buffer);
          await fs.promises.rename(tempPath, outputPath);
        } catch (cause) {
          try { await fs.promises.rm(tempPath, { force: true }); } catch {}
          throw new ExportError(ERROR_STAGE.LOCAL_WRITE, 'LOCAL_WRITE_ERROR', {
            localPath: outputPath,
          }, cause);
        }

        const sha256 = fileSha256(content.buffer);
        return {
          ok: true,
          status: 'success',
          fileId: String(item.id || ''),
          groupId: String(item.groupId || ''),
          name: item.name || '',
          relativePath: item.relativePath || '',
          outputPath,
          outputExtension: path.extname(outputPath).toLowerCase(),
          attempts: attempt,
          downloadUrlRequestCount: attempt,
          fileSize: content.buffer.length,
          sha256,
          validation,
          contentType: content.contentType,
          startedAt,
          finishedAt: new Date().toISOString(),
          attemptLog: attempts.concat([{
            attempt,
            stage: 'success',
            downloadUrlHost: downloadInfo.urlSummary?.host || '',
          }]),
        };
      } catch (error) {
        lastError = error;
        attempts.push({
          attempt,
          errorStage: error.stage || ERROR_STAGE.UNKNOWN,
          errorCode: error.code || error.message || 'UNKNOWN_ERROR',
          httpStatus: error.httpStatus || '',
          downloadUrlHost: downloadInfo?.urlSummary?.host || error.details?.downloadUrlSummary?.host || '',
        });
        if (!this.retryPolicy.isRetryable(error, attempt, maxAttempts)) break;
      }
    }

    return {
      ok: false,
      status: 'failed',
      fileId: String(item.id || ''),
      groupId: String(item.groupId || ''),
      name: item.name || '',
      relativePath: item.relativePath || '',
      outputPath,
      outputExtension: path.extname(outputPath).toLowerCase(),
      attempts: attempts.length,
      downloadUrlRequestCount: attempts.length,
      errorStage: lastError?.stage || ERROR_STAGE.UNKNOWN,
      errorCode: lastError?.code || lastError?.message || 'UNKNOWN_ERROR',
      httpStatus: lastError?.httpStatus || '',
      validation: lastError?.details?.validation || null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attemptLog: attempts,
    };
  }
}

module.exports = {
  DirectDownloader,
  fileSha256,
  validationTypeFor,
};

