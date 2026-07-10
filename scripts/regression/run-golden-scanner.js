#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadConfig } = require('../../src/config/config');
const { SessionStore } = require('../../src/auth/session-store');

function parseArgs(argv) {
  const options = {
    url: '',
    output: '',
    goldenScript: path.resolve(__dirname, '..', '..', '..', 'workspaces', 'kdocs-downloader-stability', 'script.js'),
    credentialPath: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
    else if (arg === '--golden-script') options.goldenScript = argv[++index] || options.goldenScript;
    else if (arg === '--credential-path') options.credentialPath = argv[++index] || '';
  }
  if (!options.url) throw new Error('--url is required');
  if (!options.output) throw new Error('--output is required');
  return options;
}

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

function injectGoldenExports(source) {
  const marker = '    // 闃叉閲嶅鍒濆鍖栵紙鑴氭湰鍙兘琚敞鍏ュ娆★級';
  const fallbackMarker = '    if (window.__KDOCS_DL_INIT__) return;';
  const exportCode = `
    globalThis.__GOLDEN_SCANNER_EXPORTS__ = {
        CONFIG,
        NODE_TYPE,
        PAGE_TYPE,
        Utils,
        DataService,
        parsePageUrl,
        initRootAndFetch,
        TreeModel,
    };
    return;
`;
  if (source.includes(marker)) return source.replace(marker, `${exportCode}\n${marker}`);
  if (source.includes(fallbackMarker)) return source.replace(fallbackMarker, `${exportCode}\n${fallbackMarker}`);
  throw new Error('Unable to locate Golden initialization marker');
}

function buildFetch(cookie) {
  return async function authenticatedFetch(input, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Cookie')) headers.set('Cookie', cookie);
    return fetch(input, { ...init, headers });
  };
}

function normalizeNode(node, kind, relativePath) {
  return {
    schemaVersion: 1,
    recordType: kind,
    id: String(node.id || ''),
    kind,
    groupId: String(node.groupid || ''),
    parentId: String(node.parentid || ''),
    relativePath,
    fileType: String(node.rawFtype || node.type || ''),
    linkUrlPresent: Boolean(node.linkUrl),
    name: String(node.name || ''),
    size: Number(node.size || 0),
  };
}

function flattenGoldenTree(root) {
  const records = [];
  const stack = [{ node: root, relativePath: '', isRoot: true }];
  while (stack.length) {
    const current = stack.pop();
    const kind = current.node.type === 'folder' || current.isRoot ? 'folder' : 'file';
    records.push(normalizeNode(current.node, kind, current.relativePath));
    const children = current.node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        node: child,
        relativePath: current.relativePath
          ? `${current.relativePath}/${child.name}`
          : String(child.name || ''),
        isRoot: false,
      });
    }
  }
  return records;
}

async function main() {
  const options = parseArgs(process.argv);
  const config = loadConfig({ credentialPath: options.credentialPath || undefined });
  const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const source = injectGoldenExports(fs.readFileSync(path.resolve(options.goldenScript), 'utf8'));
  const locationUrl = new URL(options.url);
  const localStorage = createLocalStorage();
  class HTMLElement {}
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
    location: {
      href: locationUrl.toString(),
      origin: locationUrl.origin,
      hostname: locationUrl.hostname,
      pathname: locationUrl.pathname,
      search: locationUrl.search,
      hash: locationUrl.hash,
    },
    localStorage,
    HTMLElement,
    customElements: {
      get() { return undefined; },
      define() {},
    },
    document: {
      body: { appendChild() {}, innerText: '' },
      createElement() { return {}; },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(source, { filename: options.goldenScript }).runInContext(context);

  const golden = context.__GOLDEN_SCANNER_EXPORTS__;
  if (!golden) throw new Error('Golden scanner exports were not captured');
  const scanStartedAt = new Date().toISOString();
  const pageInfo = golden.parsePageUrl();
  const root = await golden.initRootAndFetch(pageInfo);
  await golden.DataService.processFolderStack(root);
  const scanFinishedAt = new Date().toISOString();
  const records = flattenGoldenTree(root);
  const outputPath = path.resolve(options.output);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const summary = {
    schemaVersion: 1,
    recordType: 'scan_summary',
    implementation: 'golden',
    scanStartedAt,
    scanFinishedAt,
    sourceUrl: options.url,
    rootId: String(root.id || ''),
    groupId: String(root.groupid || ''),
    nodeCount: records.length,
    folderCount: records.filter((record) => record.kind === 'folder').length,
    fileCount: records.filter((record) => record.kind === 'file').length,
  };
  const lines = [JSON.stringify(summary), ...records.map((record) => JSON.stringify(record))];
  await fs.promises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, output: outputPath, summary }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error_name: error.name,
    error_message: error.message,
    stack: error.stack,
  }, null, 2));
  process.exitCode = 1;
});

