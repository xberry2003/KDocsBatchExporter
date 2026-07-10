'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const DEFAULT_CREDENTIAL_PATH = path.join(os.homedir(), '.claude', 'secrets', 'wps365.json');
const BASE_URL = 'https://365.kdocs.cn';
const DEFAULT_EXPORT_ATTRS = encodeURIComponent(
  Buffer.from(JSON.stringify({ host: BASE_URL }), 'utf8').toString('base64')
);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilename(name, fallback = 'untitled') {
  const cleaned = String(name || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

function replaceExt(name, ext) {
  return safeFilename(String(name || '').replace(/\.[^.]+$/, '') || 'untitled') + ext;
}

function parseCookie(cookie) {
  const out = {};
  for (const item of String(cookie || '').split(';')) {
    const idx = item.indexOf('=');
    if (idx <= 0) continue;
    const name = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (!out[name]) out[name] = value;
  }
  return out;
}

function loadCredentials(credentialPath = DEFAULT_CREDENTIAL_PATH) {
  if (!fs.existsSync(credentialPath)) {
    const err = new Error(`Credential file not found: ${credentialPath}`);
    err.code = 'AUTH_CREDENTIAL_NOT_FOUND';
    throw err;
  }
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  if (!creds.cookie) {
    const err = new Error('Credential missing cookie');
    err.code = 'AUTH_COOKIE_MISSING';
    throw err;
  }
  if (!creds.csrf) {
    const err = new Error('Credential missing csrf');
    err.code = 'AUTH_CSRF_MISSING';
    throw err;
  }
  return creds;
}

function makeHttpError(message, res, extra = {}) {
  const err = new Error(message);
  err.status = res && res.status;
  err.contentType = res && res.headers && res.headers.get('content-type') || '';
  Object.assign(err, extra);
  return err;
}

function jsonShape(value, depth = 0) {
  if (depth > 4) return '<max-depth>';
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? [jsonShape(value[0], depth + 1)] : [];
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = jsonShape(value[key], depth + 1);
    return out;
  }
  return typeof value;
}

function redactForLog(value, depth = 0) {
  if (depth > 4) return '<max-depth>';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => redactForLog(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (/cookie|authorization|token|csrf|signature|sign|url/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactForLog(value[key], depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return '[REDACTED_URL]';
    return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  }
  return value;
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Preserve a short preview in the thrown error.
  }
  if (!res.ok) {
    throw makeHttpError(`HTTP_${res.status}`, res, {
      body: json,
      bodyShape: jsonShape(json),
      textPreview: text.slice(0, 300),
    });
  }
  if (!json) {
    throw makeHttpError('JSON_PARSE_FAILED', res, { textPreview: text.slice(0, 300) });
  }
  return { status: res.status, contentType: res.headers.get('content-type') || '', body: json };
}

async function downloadBinary(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream,*/*',
      ...headers,
    },
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw makeHttpError(`DOWNLOAD_HTTP_${res.status}`, res, { size: buffer.length });
  }
  return { status: res.status, contentType: res.headers.get('content-type') || '', buffer };
}

function hasZipName(buffer, entryName) {
  return buffer.includes(Buffer.from(entryName, 'utf8'));
}

function validateDocx(buffer) {
  const magic = buffer.subarray(0, 4).toString('latin1');
  const validation = {
    size: buffer.length,
    magic,
    zip_magic_pass: magic === 'PK\u0003\u0004',
    has_content_types: hasZipName(buffer, '[Content_Types].xml'),
    has_rels: hasZipName(buffer, '_rels/.rels'),
    has_document_xml: hasZipName(buffer, 'word/document.xml'),
    word_entry_name_hits: (buffer.toString('latin1').match(/word\//g) || []).length,
  };
  validation.pass = Boolean(
    validation.zip_magic_pass &&
    validation.has_content_types &&
    validation.has_rels &&
    validation.has_document_xml &&
    validation.word_entry_name_hits > 0
  );
  return validation;
}

function classifyError(error, stage = '') {
  if (error.code) return error.code;
  if (error.status === 401 || error.status === 403) return `${stage || 'HTTP'}_${error.status}`;
  if (String(error.message || '').includes('fetch failed')) return 'NETWORK_FETCH_FAILED';
  if (String(error.message || '').startsWith('EXPORT_TASK_')) return error.message;
  if (String(error.message || '').startsWith('DOCX_VALIDATION_FAILED')) return 'DOCX_VALIDATION_FAILED';
  return stage ? `${stage}_FAILED` : 'UNKNOWN_ERROR';
}

class AirPageDocxExporter {
  constructor(options = {}) {
    this.credentialPath = options.credentialPath || DEFAULT_CREDENTIAL_PATH;
    this.timeoutMs = options.timeoutMs || 120000;
    this.pollMs = options.pollMs || 1500;
    this.attrs = options.attrs || DEFAULT_EXPORT_ATTRS;
    this.credentials = options.credentials || null;
  }

  getCredentials() {
    if (!this.credentials) this.credentials = loadCredentials(this.credentialPath);
    return this.credentials;
  }

  commonHeaders(fileId) {
    const creds = this.getCredentials();
    const csrf = String(creds.csrf || '');
    return {
      Cookie: creds.cookie,
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/office/o/${encodeURIComponent(fileId)}`,
      'x-csrf-rand': csrf,
    };
  }

  authSummary() {
    const creds = this.getCredentials();
    return {
      cookie_present: Boolean(creds.cookie),
      csrf_present: Boolean(creds.csrf),
      csrf_length: String(creds.csrf || '').length,
      wps_sid_present: /(?:^|;\s*)wps_sid=/.test(creds.cookie),
    };
  }

  async fetchMetadata(fileId) {
    const creds = this.getCredentials();
    const url = `${BASE_URL}/3rd/drive/api/v5/files/${encodeURIComponent(fileId)}/metadata`;
    const res = await requestJson(url, {
      headers: {
        Cookie: creds.cookie,
        Referer: `${BASE_URL}/office/o/${encodeURIComponent(fileId)}`,
      },
    });
    const info = res.body.fileinfo || res.body.data?.fileinfo || res.body.data || {};
    return {
      status: res.status,
      fileid: String(info.fileid || info.id || fileId),
      fver: info.fver == null ? '' : String(info.fver),
      fname: info.fname || '',
      ftype: info.ftype || '',
      groupid: info.groupid || '',
      parentid: info.parentid || '',
      fsize: info.fsize || 0,
      keys: Object.keys(info).sort(),
    };
  }

  async createExportTask(fileId, metadata, options = {}) {
    const creds = this.getCredentials();
    const csrf = String(creds.csrf || '');
    const cookies = parseCookie(creds.cookie);
    const fallbackRevision = cookies['xsr-cache-revision'] || cookies['xsr-cache-fileVersion'] || '';
    const body = {
      attrs: options.attrs || this.attrs,
      csrfmiddlewaretoken: csrf,
      format: 'docx',
      ver: options.ver || metadata.fver || fallbackRevision,
    };
    const url = `${BASE_URL}/api/v3/office/file/${encodeURIComponent(fileId)}/export/docx/preload`;
    const res = await requestJson(url, {
      method: 'POST',
      headers: this.commonHeaders(fileId),
      body,
    });
    return { response: res, body };
  }

  async pollExportResult(fileId, taskId, taskType) {
    const creds = this.getCredentials();
    const body = {
      csrfmiddlewaretoken: String(creds.csrf || ''),
      task_id: taskId,
      task_type: taskType,
    };
    const url = `${BASE_URL}/api/v3/office/file/${encodeURIComponent(fileId)}/export/docx/result`;
    const deadline = Date.now() + this.timeoutMs;
    let pollCount = 0;
    let last = null;
    while (Date.now() < deadline) {
      pollCount += 1;
      const res = await requestJson(url, {
        method: 'POST',
        headers: this.commonHeaders(fileId),
        body,
      });
      last = res;
      const status = String(res.body?.status || '').toLowerCase();
      if (status === 'finished' && res.body?.data?.url) {
        return { response: res, requestBody: body, pollCount };
      }
      if (['failed', 'fail', 'error'].includes(status)) {
        const err = new Error(`EXPORT_TASK_${status.toUpperCase()}`);
        err.body = res.body;
        err.bodyShape = jsonShape(res.body);
        err.bodySummary = redactForLog(res.body);
        err.apiStatus = res.body?.status || '';
        err.pollCount = pollCount;
        throw err;
      }
      await sleep(this.pollMs);
    }
    const err = new Error('EXPORT_TASK_TIMEOUT');
    err.body = last?.body || null;
    err.bodySummary = redactForLog(last?.body || null);
    err.apiStatus = last?.body?.status || '';
    err.pollCount = pollCount;
    throw err;
  }

  async downloadDocx(downloadUrl) {
    return downloadBinary(downloadUrl);
  }

  async exportFile(item, options = {}) {
    const fileId = String(item.file_id || item.fileid || item.id || item.fileId || '').trim();
    if (!/^\d+$/.test(fileId)) {
      const err = new Error(`Invalid file id: ${fileId}`);
      err.code = 'INVALID_FILE_ID';
      throw err;
    }

    const startedAt = nowIso();
    const timeline = [];
    let metadata = null;
    let taskType = '';
    let stage = 'metadata';
    try {
      metadata = await this.fetchMetadata(fileId);
      timeline.push({ step: 'metadata', status: metadata.status, fver: metadata.fver, ftype: metadata.ftype });

      stage = 'preload';
      const preload = await this.createExportTask(fileId, metadata, options);
      const taskId = preload.response.body?.task_id;
      taskType = preload.response.body?.task_type || 'normal_export';
      timeline.push({
        step: 'preload',
        status: preload.response.status,
        content_type: preload.response.contentType,
        request_fields: Object.keys(preload.body).sort(),
        response_fields: Object.keys(preload.response.body || {}).sort(),
      });
      if (!taskId) {
        const err = new Error('PRELOAD_MISSING_TASK_ID');
        err.body = preload.response.body;
        err.bodyShape = jsonShape(preload.response.body);
        throw err;
      }

      stage = 'result';
      const result = await this.pollExportResult(fileId, taskId, taskType);
      const downloadUrl = result.response.body.data.url;
      timeline.push({
        step: 'result',
        status: result.response.status,
        api_status: result.response.body.status,
        poll_count: result.pollCount,
        request_fields: Object.keys(result.requestBody).sort(),
        response_fields: Object.keys(result.response.body || {}).sort(),
        has_data_url: true,
      });

      stage = 'download';
      const download = await this.downloadDocx(downloadUrl);
      const validation = validateDocx(download.buffer);
      timeline.push({
        step: 'download',
        status: download.status,
        content_type: download.contentType,
        size: download.buffer.length,
        docx_validation_pass: validation.pass,
        download_url_host: new URL(downloadUrl).host,
        download_url_path: new URL(downloadUrl).pathname,
      });
      if (!validation.pass) {
        const err = new Error('DOCX_VALIDATION_FAILED');
        err.validation = validation;
        throw err;
      }

      const outputPath = path.resolve(options.outputPath || path.join(
        options.outputDir || process.cwd(),
        replaceExt(item.output_name || item.name || metadata.fname || `file-${fileId}.otl`, '.docx')
      ));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, download.buffer);
      fs.renameSync(tmpPath, outputPath);

      return {
        ok: true,
        status: 'success',
        file_id: fileId,
        key: item.key || `${item.groupid || metadata.groupid || ''}:${fileId}:${item.path || item.name || metadata.fname || ''}`,
        name: item.name || metadata.fname || '',
        path: item.path || '',
        groupid: item.groupid || metadata.groupid || '',
        output_path: outputPath,
        started_at: startedAt,
        finished_at: nowIso(),
        auth: this.authSummary(),
        metadata,
        export: {
          task_type: taskType,
          poll_count: result.pollCount,
          download_url_host: new URL(downloadUrl).host,
          download_url_path: new URL(downloadUrl).pathname,
        },
        validation,
        timeline,
      };
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        file_id: fileId,
        key: item.key || `${item.groupid || ''}:${fileId}:${item.path || item.name || ''}`,
        name: item.name || '',
        path: item.path || '',
        groupid: item.groupid || '',
        started_at: startedAt,
        finished_at: nowIso(),
        error_stage: stage,
        error_code: classifyError(error, stage),
        error_message: String(error.message || error),
        http_status: error.status || '',
        content_type: error.contentType || '',
        response_shape: error.bodyShape || (error.body && typeof error.body === 'object' ? Object.keys(error.body).sort() : []),
        response_summary: error.bodySummary || null,
        api_status: error.apiStatus || '',
        poll_count: error.pollCount || '',
        metadata,
        export: taskType ? { task_type: taskType } : null,
        validation: error.validation || null,
        timeline,
      };
    }
  }
}

module.exports = {
  AirPageDocxExporter,
  DEFAULT_CREDENTIAL_PATH,
  DEFAULT_EXPORT_ATTRS,
  loadCredentials,
  validateDocx,
  safeFilename,
  replaceExt,
};
