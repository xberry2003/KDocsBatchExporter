#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../../src/config/config');
const { SessionStore } = require('../../src/auth/session-store');
const { KDocsApiClient } = require('../../src/kdocs/api-client');
const { parseKDocsUrl } = require('../../src/kdocs/folder-identity');
const { KDocsFolderScanner } = require('../../src/kdocs/folder-scanner');

function parseArgs(argv) {
  const options = { url: '', output: '', credentialPath: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
    else if (arg === '--credential-path') options.credentialPath = argv[++index] || '';
  }
  if (!options.url) throw new Error('--url is required');
  if (!options.output) throw new Error('--output is required');
  return options;
}

function normalizeRecord(item, kind) {
  return {
    schemaVersion: 2,
    recordType: kind,
    id: String(item.id || ''),
    kind,
    groupId: String(item.groupId || ''),
    parentId: String(item.parentId || ''),
    relativePath: String(item.relativePath || ''),
    fileType: String(item.fileType || ''),
    linkUrlPresent: Boolean(item.linkUrl),
    name: String(item.name || ''),
    size: Number(item.size || 0),
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const config = loadConfig({ credentialPath: options.credentialPath || undefined });
  const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const apiClient = new KDocsApiClient({
    sessionStore,
    baseUrl: config.kdocsBaseUrl,
  });
  const scanner = new KDocsFolderScanner({ apiClient });
  const identity = parseKDocsUrl(options.url);
  const scanStartedAt = new Date().toISOString();
  const result = await scanner.scan(identity, { traversal: 'stack' });
  const scanFinishedAt = new Date().toISOString();
  const records = [
    normalizeRecord(result.root, 'folder'),
    ...result.folders
      .filter((folder) => String(folder.id) !== String(result.root.id))
      .map((folder) => normalizeRecord(folder, 'folder')),
    ...result.files.map((file) => normalizeRecord(file, 'file')),
  ];
  const summary = {
    schemaVersion: 2,
    recordType: 'scan_summary',
    implementation: 'new',
    scanStartedAt,
    scanFinishedAt,
    sourceUrl: options.url,
    rootId: String(result.root.id || ''),
    groupId: String(result.root.groupId || ''),
    nodeCount: records.length,
    folderCount: records.filter((record) => record.kind === 'folder').length,
    fileCount: records.filter((record) => record.kind === 'file').length,
  };
  const outputPath = path.resolve(options.output);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(
    outputPath,
    `${[JSON.stringify(summary), ...records.map((record) => JSON.stringify(record))].join('\n')}\n`,
    'utf8'
  );
  console.log(JSON.stringify({ ok: true, output: outputPath, summary }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error_name: error.name,
    error_message: error.message,
    stage: error.stage || '',
    http_status: error.httpStatus || '',
  }, null, 2));
  process.exitCode = 1;
});

