#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../../src/config/config');
const { SessionStore } = require('../../src/auth/session-store');
const { KDocsApiClient } = require('../../src/kdocs/api-client');
const { parseKDocsUrl } = require('../../src/kdocs/folder-identity');
const { KDocsFolderScanner } = require('../../src/kdocs/folder-scanner');

function parseArgs(argv) {
  const options = {
    url: '',
    minNodes: 50,
    maxNodes: 500,
    maxCandidates: 30,
    credentialPath: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index] || '';
    else if (arg === '--min-nodes') options.minNodes = Number(argv[++index] || options.minNodes);
    else if (arg === '--max-nodes') options.maxNodes = Number(argv[++index] || options.maxNodes);
    else if (arg === '--max-candidates') options.maxCandidates = Number(argv[++index] || options.maxCandidates);
    else if (arg === '--credential-path') options.credentialPath = argv[++index] || '';
  }
  if (!options.url) throw new Error('--url is required');
  return options;
}

function typeSummary(files) {
  const extensions = new Set();
  for (const file of files) {
    const match = String(file.name || '').toLowerCase().match(/(\.[^.]+)$/);
    if (match) extensions.add(match[1]);
  }
  return [...extensions].sort();
}

async function main() {
  const options = parseArgs(process.argv);
  const config = loadConfig({ credentialPath: options.credentialPath || undefined });
  const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const apiClient = new KDocsApiClient({ sessionStore, baseUrl: config.kdocsBaseUrl });
  const scanner = new KDocsFolderScanner({ apiClient });
  const rootIdentity = parseKDocsUrl(options.url);
  const rootChildren = await apiClient.listFolderFiles(rootIdentity.groupId, rootIdentity.parentId, {
    sourceUrl: rootIdentity.sourceUrl,
  });
  const folders = rootChildren.filter((item) => item.isFolder).slice(0, options.maxCandidates);
  const candidates = [];

  for (const folder of folders) {
    const candidateUrl = new URL(options.url);
    const segments = candidateUrl.pathname.split('/').filter(Boolean).slice(0, 3);
    candidateUrl.pathname = `/${segments.join('/')}/${folder.id}`;
    try {
      const result = await scanner.scan({
        ...rootIdentity,
        parentId: folder.id,
        folderId: folder.id,
        sourceUrl: candidateUrl.toString(),
      }, {
        traversal: 'stack',
        maxFolders: 100,
        rootName: folder.name,
      });
      const nodeCount = result.stats.folderCount + result.stats.fileCount;
      const maxDepth = Math.max(
        0,
        ...[...result.folders, ...result.files].map((item) => (
          String(item.relativePath || '').split('/').filter(Boolean).length
        ))
      );
      candidates.push({
        name: folder.name,
        url: candidateUrl.toString(),
        groupId: folder.groupId,
        folderId: folder.id,
        nodeCount,
        folderCount: result.stats.folderCount,
        fileCount: result.stats.fileCount,
        maxDepth,
        extensions: typeSummary(result.files),
        otlCount: result.files.filter((file) => String(file.name || '').toLowerCase().endsWith('.otl')).length,
        linkUrlCount: [...result.folders, ...result.files].filter((item) => item.linkUrl).length,
        truncated: result.stats.truncated,
        recommended: !result.stats.truncated &&
          nodeCount >= options.minNodes &&
          nodeCount <= options.maxNodes &&
          maxDepth >= 2 &&
          result.stats.folderCount >= 2 &&
          result.stats.fileCount > 0,
      });
    } catch (error) {
      candidates.push({
        name: folder.name,
        folderId: folder.id,
        error: error.message,
        stage: error.stage || '',
      });
    }
  }

  candidates.sort((left, right) => (
    Number(right.recommended) - Number(left.recommended) ||
    Math.abs(left.nodeCount - 150) - Math.abs(right.nodeCount - 150)
  ));
  console.log(JSON.stringify({ ok: true, candidates }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error_name: error.name,
    error_message: error.message,
  }, null, 2));
  process.exitCode = 1;
});

