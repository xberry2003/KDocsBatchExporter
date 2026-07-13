#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadConfig } = require('../../src/config/config');
const { SessionStore } = require('../../src/auth/session-store');
const { resolveOutputPath } = require('../../src/download/output-path-resolver');
const { validateBuffer } = require('../../src/download/validators');
const { validationTypeFor } = require('../../src/download/direct-downloader');

function parseArgs(argv) {
  const options = {
    input: '',
    outputDir: '',
    result: '',
    goldenScript: path.resolve(__dirname, '..', '..', '..', 'workspaces', 'kdocs-downloader-stability', 'script.js'),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') options.input = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--result') options.result = argv[++index] || '';
    else if (arg === '--golden-script') options.goldenScript = argv[++index] || options.goldenScript;
  }
  if (!options.input || !options.outputDir || !options.result) throw new Error('--input, --output-dir and --result are required');
  return options;
}

function injectGoldenExports(source) {
  const marker = '    // 闃叉閲嶅鍒濆鍖栵紙鑴氭湰鍙兘琚敞鍏ュ娆★級';
  const fallbackMarker = '    if (window.__KDOCS_DL_INIT__) return;';
  const exportCode = `
    globalThis.__GOLDEN_DIRECT_EXPORTS__ = { DataService, DownloadEngine, Utils };
    return;
`;
  if (source.includes(marker)) return source.replace(marker, `${exportCode}\n${marker}`);
  if (source.includes(fallbackMarker)) return source.replace(fallbackMarker, `${exportCode}\n${fallbackMarker}`);
  throw new Error('Unable to locate Golden initialization marker');
}

function createLocalStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
}

function buildFetch(cookie) {
  return async function authenticatedFetch(input, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Cookie')) headers.set('Cookie', cookie);
    return fetch(input, { ...init, headers });
  };
}

function readSample(input) {
  return fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const options = parseArgs(process.argv);
  const config = loadConfig();
  const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const source = injectGoldenExports(fs.readFileSync(options.goldenScript, 'utf8'));
  const context = {
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Blob,
    console,
    setTimeout,
    clearTimeout,
    fetch: buildFetch(sessionStore.getCookie()),
    location: { href: 'https://365.kdocs.cn/ent/0/0', origin: 'https://365.kdocs.cn', pathname: '/ent/0/0', hash: '', search: '' },
    localStorage: createLocalStorage(),
    HTMLElement: class {},
    customElements: { get() {}, define() {} },
    document: { body: { appendChild() {}, innerText: '' }, createElement() { return {}; } },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(source, { filename: options.goldenScript }).runInContext(context);
  const golden = context.__GOLDEN_DIRECT_EXPORTS__;
  if (!golden) throw new Error('Golden direct exports were not captured');

  await fs.promises.mkdir(options.outputDir, { recursive: true });
  await fs.promises.mkdir(path.dirname(options.result), { recursive: true });
  await fs.promises.writeFile(options.result, '', 'utf8');

  for (const item of readSample(options.input)) {
    const startedAt = new Date().toISOString();
    const outputPath = resolveOutputPath(options.outputDir, item, 'DIRECT_DOWNLOAD');
    let record;
    try {
      const downloadInfo = await golden.DataService.fetchDownloadUrlInfo(item.groupId, item.id);
      const bytes = Buffer.from(await golden.DownloadEngine.fetchWithProgress(downloadInfo.url));
      const validation = validateBuffer(bytes, validationTypeFor(item));
      if (!validation.pass) throw Object.assign(new Error('VALIDATION_FAILED'), { stage: 'VALIDATION', validation });
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, bytes);
      record = {
        status: 'success',
        ok: true,
        attempts: 1,
        errorStage: '',
        httpStatus: '',
        fileSize: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        validationResult: validation,
      };
    } catch (error) {
      record = {
        status: 'failed',
        ok: false,
        attempts: 1,
        errorStage: error.stage || error.details?.stage || 'UNKNOWN',
        httpStatus: error.httpStatus || error.details?.httpStatus || error.details?.downloadApiStatus || '',
        fileSize: 0,
        sha256: '',
        validationResult: error.validation || null,
        errorCode: error.message || 'UNKNOWN_ERROR',
      };
    }
    await fs.promises.appendFile(options.result, `${JSON.stringify({
      schemaVersion: 1,
      implementation: 'golden',
      fileId: item.id,
      groupId: item.groupId,
      name: item.name,
      relativePath: item.relativePath,
      outputExtension: path.extname(outputPath).toLowerCase(),
      localPath: outputPath,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...record,
    })}\n`, 'utf8');
  }
  console.log(JSON.stringify({ ok: true, result: path.resolve(options.result), outputDir: path.resolve(options.outputDir) }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
});
