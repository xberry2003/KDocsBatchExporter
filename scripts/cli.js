#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config/config');
const { SessionStore } = require('../src/auth/session-store');
const { KDocsApiClient } = require('../src/kdocs/api-client');
const { parseKDocsUrl } = require('../src/kdocs/folder-identity');
const { KDocsFolderScanner } = require('../src/kdocs/folder-scanner');

const program = new Command();

program
  .name('kdocs-batch-exporter')
  .description('KDocs 365 enterprise batch exporter')
  .version('0.1.0');

program
  .command('auth')
  .description('Inspect saved authentication state without printing secrets')
  .option('--credential-path <path>')
  .action((options) => {
    const config = loadConfig({ credentialPath: options.credentialPath });
    const store = new SessionStore({ credentialPath: config.credentialPath });
    console.log(JSON.stringify(store.summary(), null, 2));
  });

program
  .command('scan')
  .description('Scan a KDocs enterprise folder and write a JSONL inventory')
  .requiredOption('--url <url>', 'KDocs enterprise folder URL, for example https://365.kdocs.cn/ent/{orgid}/{groupid}')
  .option('--output <path>', 'scan JSONL output path')
  .option('--max-folders <n>', 'maximum folders to visit', (value) => Number(value), Number.MAX_SAFE_INTEGER)
  .option('--traversal <mode>', 'stack or queue traversal', 'stack')
  .option('--credential-path <path>')
  .action(async (options) => {
    const config = loadConfig({ credentialPath: options.credentialPath });
    const identity = parseKDocsUrl(options.url);
    const outputPath = path.resolve(
      options.output ||
      path.join(config.stateDir, 'scans', `${identity.groupId}-${Date.now()}.jsonl`)
    );
    const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
    const apiClient = new KDocsApiClient({
      sessionStore,
      baseUrl: config.kdocsBaseUrl,
    });
    const scanner = new KDocsFolderScanner({ apiClient });
    const result = await scanner.scan(identity, {
      traversal: options.traversal,
      maxFolders: options.maxFolders,
    });

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const lines = [];
    lines.push(JSON.stringify({
      schemaVersion: 2,
      recordType: 'scan_summary',
      recordedAt: new Date().toISOString(),
      identity: result.identity,
      stats: result.stats,
    }));
    for (const folder of result.folders) {
      lines.push(JSON.stringify({
        schemaVersion: 2,
        recordType: 'folder',
        id: folder.id,
        groupId: folder.groupId,
        parentId: folder.parentId,
        name: folder.name,
        fileType: folder.fileType,
        relativePath: folder.relativePath,
        linkUrlPresent: Boolean(folder.linkUrl),
      }));
    }
    for (const file of result.files) {
      lines.push(JSON.stringify({
        schemaVersion: 2,
        recordType: 'file',
        id: file.id,
        groupId: file.groupId,
        parentId: file.parentId,
        name: file.name,
        fileType: file.fileType,
        size: file.size,
        relativePath: file.relativePath,
        linkUrlPresent: Boolean(file.linkUrl),
      }));
    }
    await fs.promises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      output: outputPath,
      stats: result.stats,
    }, null, 2));
  });

for (const command of ['export', 'retry-failed', 'status', 'inspect']) {
  program
    .command(command)
    .description(`${command} command is reserved for the staged Golden migration`)
    .allowUnknownOption()
    .action(() => {
      console.error(JSON.stringify({
        ok: false,
        code: 'COMMAND_NOT_MIGRATED',
        command,
      }, null, 2));
      process.exitCode = 2;
    });
}

program.parseAsync(process.argv).catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error_name: error.name,
    error_message: error.message,
  }, null, 2));
  process.exitCode = 1;
});
