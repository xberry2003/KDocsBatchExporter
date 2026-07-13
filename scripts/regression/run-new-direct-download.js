#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../../src/config/config');
const { SessionStore } = require('../../src/auth/session-store');
const { KDocsApiClient } = require('../../src/kdocs/api-client');
const { DirectDownloader } = require('../../src/download/direct-downloader');
const { RetryPolicy } = require('../../src/download/retry-policy');
const { ManifestStore, FILE_STATUS } = require('../../src/manifest/manifest-store');
const { resolveOutputPath } = require('../../src/download/output-path-resolver');
const { validateFile } = require('../../src/download/validators');
const { validationTypeFor } = require('../../src/download/direct-downloader');

function parseArgs(argv) {
  const options = { input: '', outputDir: '', result: '', manifest: '', resume: false, concurrency: 2 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') options.input = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--result') options.result = argv[++index] || '';
    else if (arg === '--manifest') options.manifest = argv[++index] || '';
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(argv[++index] || 2));
  }
  if (!options.input || !options.outputDir || !options.result || !options.manifest) {
    throw new Error('--input, --output-dir, --result and --manifest are required');
  }
  return options;
}

function readSample(input) {
  return fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const options = parseArgs(process.argv);
  const config = loadConfig();
  const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const apiClient = new KDocsApiClient({ sessionStore, baseUrl: config.kdocsBaseUrl });
  const downloader = new DirectDownloader({
    apiClient,
    retryPolicy: new RetryPolicy({
      delays: config.directRetryDelays,
      downloadUrl403Delay: config.downloadUrl403RetryDelay,
    }),
    maxAttempts: config.directAttempts,
  });
  const manifest = new ManifestStore(options.manifest).load();
  await fs.promises.mkdir(path.dirname(options.result), { recursive: true });
  await fs.promises.writeFile(options.result, '', 'utf8');

  const items = readSample(options.input);
  await runPool(items, options.concurrency, async (item) => {
    const outputPath = resolveOutputPath(options.outputDir, item, 'DIRECT_DOWNLOAD');
    const key = `${item.groupId}:${item.id}`;
    const validator = (target) => validateFile(target, validationTypeFor(item));
    let result;
    if (options.resume && manifest.shouldSkipSuccess(key, outputPath, validator)) {
      const stat = fs.statSync(outputPath);
      result = {
        ok: true,
        status: 'skipped',
        fileId: item.id,
        groupId: item.groupId,
        name: item.name,
        relativePath: item.relativePath,
        outputPath,
        outputExtension: path.extname(outputPath).toLowerCase(),
        attempts: 0,
        fileSize: stat.size,
        validation: validator(outputPath),
        reason: 'manifest_success_output_valid',
        finishedAt: new Date().toISOString(),
      };
    } else {
      await manifest.append({
        key,
        groupId: item.groupId,
        fileId: item.id,
        name: item.name,
        relativePath: item.relativePath,
        status: FILE_STATUS.RUNNING,
        strategy: 'DIRECT_DOWNLOAD',
        outputPath,
        startedAt: new Date().toISOString(),
      });
      result = await downloader.download(item, outputPath);
      await manifest.append({
        key,
        groupId: item.groupId,
        fileId: item.id,
        name: item.name,
        relativePath: item.relativePath,
        status: result.ok ? FILE_STATUS.SUCCESS : FILE_STATUS.FAILED,
        strategy: 'DIRECT_DOWNLOAD',
        outputPath,
        attempts: result.attempts,
        errorStage: result.errorStage || '',
        errorCode: result.errorCode || '',
        validationPass: Boolean(result.validation?.pass),
        fileSize: result.fileSize || 0,
        finishedAt: new Date().toISOString(),
      });
    }
    await fs.promises.appendFile(options.result, `${JSON.stringify({
      schemaVersion: 2,
      implementation: 'new',
      fileId: item.id,
      groupId: item.groupId,
      name: item.name,
      relativePath: item.relativePath,
      localPath: outputPath,
      validationResult: result.validation || null,
      errorStage: result.errorStage || '',
      httpStatus: result.httpStatus || '',
      sha256: result.sha256 || '',
      ...result,
    })}\n`, 'utf8');
    return result;
  });
  await manifest.flush();
  console.log(JSON.stringify({ ok: true, result: path.resolve(options.result), outputDir: path.resolve(options.outputDir) }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
});

