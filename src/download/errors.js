'use strict';

const ERROR_STAGE = Object.freeze({
  DOWNLOAD_URL_API: 'DOWNLOAD_URL_API',
  FILE_CONTENT_FETCH: 'FILE_CONTENT_FETCH',
  LOCAL_DIRECTORY: 'LOCAL_DIRECTORY',
  LOCAL_FILE_HANDLE: 'LOCAL_FILE_HANDLE',
  LOCAL_WRITE: 'LOCAL_WRITE',
  STREAM_READ: 'STREAM_READ',
  VALIDATION: 'VALIDATION',
  DOCX_EXPORT_CREATE: 'DOCX_EXPORT_CREATE',
  DOCX_EXPORT_POLL: 'DOCX_EXPORT_POLL',
  DOCX_EXPORT_TIMEOUT: 'DOCX_EXPORT_TIMEOUT',
  DOCX_EXPORT_DOWNLOAD: 'DOCX_EXPORT_DOWNLOAD',
  DOCX_EXPORT_VALIDATION: 'DOCX_EXPORT_VALIDATION',
  UNKNOWN: 'UNKNOWN',
});

class ExportError extends Error {
  constructor(stage, code, details = {}, cause = null) {
    super(code || stage || 'EXPORT_ERROR');
    this.name = 'ExportError';
    this.stage = stage || ERROR_STAGE.UNKNOWN;
    this.code = code || 'UNKNOWN_ERROR';
    this.details = details;
    this.cause = cause;
    this.httpStatus = details.httpStatus || details.downloadApiStatus || null;
  }
}

module.exports = { ERROR_STAGE, ExportError };

