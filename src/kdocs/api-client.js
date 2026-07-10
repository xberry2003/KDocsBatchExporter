'use strict';

const { normalizeKDocsItem } = require('./models');

function summarizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.hostname,
      pathname: url.pathname,
      queryKeys: [...url.searchParams.keys()].sort(),
    };
  } catch {
    return { host: '', pathname: '', queryKeys: [] };
  }
}

class KDocsApiError extends Error {
  constructor(stage, message, details = {}, cause = null) {
    super(message || stage);
    this.name = 'KDocsApiError';
    this.stage = stage;
    this.details = details;
    this.cause = cause;
    this.httpStatus = details.httpStatus || details.status || null;
  }
}

class KDocsApiClient {
  constructor(options = {}) {
    if (!options.sessionStore) throw new Error('KDocsApiClient requires sessionStore');
    this.sessionStore = options.sessionStore;
    this.baseUrl = String(options.baseUrl || 'https://drive.kdocs.cn').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('Fetch implementation is required');
  }

  headers(extra = {}) {
    return {
      Accept: 'application/json, text/plain, */*',
      Cookie: this.sessionStore.getCookie(),
      ...extra,
    };
  }

  async requestJson(url, options = {}, stage = 'KDOCS_API') {
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        headers: this.headers(options.headers),
      });
    } catch (cause) {
      throw new KDocsApiError(stage, `${stage}_NETWORK_ERROR`, { url: summarizeUrl(url) }, cause);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // The shortened preview is retained in the standardized error below.
    }

    if (!response.ok) {
      throw new KDocsApiError(stage, `${stage}_${response.status}`, {
        httpStatus: response.status,
        contentType,
        bodyResult: body?.result || '',
        bodyPreview: body ? '' : text.slice(0, 200),
        url: summarizeUrl(url),
      });
    }
    if (!body) {
      throw new KDocsApiError(stage, `${stage}_JSON_PARSE_FAILED`, {
        httpStatus: response.status,
        contentType,
        bodyPreview: text.slice(0, 200),
        url: summarizeUrl(url),
      });
    }
    return { status: response.status, contentType, body };
  }

  async getMetadata(fileId) {
    const url = `${this.baseUrl}/api/v5/files/${encodeURIComponent(fileId)}/metadata`;
    const response = await this.requestJson(url, {}, 'METADATA_API');
    const fileInfo = response.body.fileinfo || response.body.data?.fileinfo || response.body.data;
    if (response.body.result !== 'ok' || !fileInfo) {
      throw new KDocsApiError('METADATA_API', 'METADATA_API_INVALID_RESPONSE', {
        httpStatus: response.status,
        bodyResult: response.body.result || '',
        url: summarizeUrl(url),
      });
    }
    return normalizeKDocsItem(fileInfo);
  }

  async listFolderFiles(groupId, parentId, context = {}) {
    const query = new URLSearchParams({
      linkgroup: 'true',
      parentid: String(parentId),
      include: '',
      with_link: 'true',
      review_pic_thumbnail: 'true',
      offset: '0',
      count: '99999',
      order: 'DESC',
      orderby: 'mtime',
      exclude_exts: '',
      include_exts: '',
    });
    const url = `${this.baseUrl}/api/v5/groups/${encodeURIComponent(groupId)}/files?${query}`;
    const response = await this.requestJson(url, {}, 'FOLDER_FILES_API');
    if (response.body.result !== 'ok' || !Array.isArray(response.body.files)) {
      throw new KDocsApiError('FOLDER_FILES_API', 'FOLDER_FILES_API_INVALID_RESPONSE', {
        httpStatus: response.status,
        bodyResult: response.body.result || '',
        url: summarizeUrl(url),
      });
    }
    return response.body.files.map((file) => normalizeKDocsItem(file, {
      groupId,
      parentId,
      sourceUrl: context.sourceUrl,
    }));
  }

  async getDownloadUrlInfo(groupId, fileId) {
    const query = new URLSearchParams({
      isblocks: 'false',
      support_checksums: 'md5,sha1,sha224,sha256,sha384,sha512',
    });
    const url = `${this.baseUrl}/api/v5/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(fileId)}/download?${query}`;
    const response = await this.requestJson(url, {}, 'DOWNLOAD_URL_API');
    if (response.body.result !== 'ok' || !response.body.url) {
      throw new KDocsApiError('DOWNLOAD_URL_API', 'DOWNLOAD_URL_API_NO_URL', {
        httpStatus: response.status,
        bodyResult: response.body.result || '',
        url: summarizeUrl(url),
      });
    }
    return {
      url: response.body.url,
      status: response.status,
      contentType: response.contentType,
      urlSummary: summarizeUrl(response.body.url),
    };
  }
}

module.exports = {
  KDocsApiClient,
  KDocsApiError,
  summarizeUrl,
};

