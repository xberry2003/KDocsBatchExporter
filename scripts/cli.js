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
const { runRetryFailed, runUnifiedExport } = require('../src/export/unified-exporter');

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

program
  .command('export')
  .description('Scan and export a KDocs enterprise folder with mixed strategies')
  .requiredOption('--url <url>', 'KDocs enterprise folder URL')
  .requiredOption('--output <path>', 'output directory for exported files')
  .option('--task-dir <path>', 'directory for task state files')
  .option('--state-dir <path>', 'alias of --task-dir for task state files')
  .option('--state-root <path>', 'base directory; task identity will be appended')
  .option('--find-child-name <name>', 'resolve exactly one direct child folder before scanning')
  .option('--scan-only', 'write task, scan, routing plan and audit without downloading')
  .option('--continue-on-error', 'continue after per-file failures', true)
  .option('--manual-ext <extension>', 'extension that requires manual handling', (value, previous) => previous.concat(value), [])
  .option('--name <name>', 'human-readable directory name for reports/task state')
  .option('--direct-concurrency <n>', 'direct download concurrency', (value) => Number(value), 2)
  .option('--airpage-concurrency <n>', 'AirPage export concurrency', (value) => Number(value), 1)
  .option('--direct-attempts <n>', 'direct download attempts', (value) => Number(value), 3)
  .option('--airpage-attempts <n>', 'AirPage export attempts', (value) => Number(value), 2)
  .option('--max-folders <n>', 'maximum folders to scan', (value) => Number(value), Number.MAX_SAFE_INTEGER)
  .option('--traversal <mode>', 'stack or queue traversal', 'stack')
  .option('--credential-path <path>')
  .action(async (options) => {
    const result = await runUnifiedExport({
      url: options.url,
      output: options.output,
      taskDir: options.taskDir || options.stateDir,
      stateRoot: options.stateRoot,
      findChildName: options.findChildName,
      scanOnly: Boolean(options.scanOnly),
      continueOnError: Boolean(options.continueOnError),
      manualExt: options.manualExt,
      name: options.name,
      directConcurrency: options.directConcurrency,
      airpageConcurrency: options.airpageConcurrency,
      directAttempts: options.directAttempts,
      airpageAttempts: options.airpageAttempts,
      maxFolders: options.maxFolders,
      traversal: options.traversal,
      credentialPath: options.credentialPath,
    });
    console.log(JSON.stringify({
      ok: result.scanOnly ? true : result.supportedFailedCount === 0 && result.failedCount === 0,
      taskIdentity: result.taskIdentity,
      totalFileCount: result.totalFileCount,
      successCount: result.successCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
      paths: result.paths,
    }, null, 2));
    if (!result.scanOnly && (result.supportedFailedCount !== 0 || result.failedCount !== 0)) process.exitCode = 1;
  });

program
  .command('retry-failed')
  .description('Retry automatically failed AirPage DOCX exports from an existing task directory')
  .requiredOption('--task-dir <path>', 'task state directory containing failed-files.jsonl')
  .option('--credential-path <path>')
  .option('--airpage-concurrency <n>', 'AirPage export retry concurrency', (value) => Number(value), 1)
  .option('--airpage-attempts <n>', 'AirPage export retry attempts', (value) => Number(value), 4)
  .option('--airpage-retry-delay-ms <n>', 'delay between AirPage retry attempts', (value) => Number(value), 5000)
  .action(async (options) => {
    const result = await runRetryFailed({
      taskDir: options.taskDir,
      credentialPath: options.credentialPath,
      airpageConcurrency: options.airpageConcurrency,
      airpageAttempts: options.airpageAttempts,
      airpageRetryDelayMs: options.airpageRetryDelayMs,
    });
    console.log(JSON.stringify({
      ok: result.supportedFailedCount === 0,
      taskIdentity: result.taskIdentity,
      retriedCount: result.retriedCount,
      retrySuccessCount: result.retrySuccessCount,
      retryFailedCount: result.retryFailedCount,
      successCount: result.successCount,
      failedCount: result.failedCount,
      manualDownloadRequiredCount: result.manualDownloadRequiredCount,
      supportedFailedCount: result.supportedFailedCount,
      paths: result.paths,
    }, null, 2));
    if (result.supportedFailedCount !== 0) process.exitCode = 1;
  });

for (const command of ['status', 'inspect']) {
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
