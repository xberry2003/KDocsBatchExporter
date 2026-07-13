#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { AirPageDocxExporter, validateDocx } = require('../../src/airpage/docx-exporter');
const { ManifestStore, FILE_STATUS } = require('../../src/manifest/manifest-store');
const { resolveOutputPath } = require('../../src/download/output-path-resolver');

function parseArgs(argv) {
  const options = {
    input: '',
    outputDir: '',
    manifest: '',
    result: '',
    attempts: 2,
    concurrency: 1,
    timeoutMs: 120000,
    pollMs: 1500,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') options.input = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--manifest') options.manifest = argv[++index] || '';
    else if (arg === '--result') options.result = argv[++index] || '';
    else if (arg === '--attempts') options.attempts = Math.max(1, Number(argv[++index] || 2));
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(argv[++index] || 1));
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index] || options.timeoutMs);
    else if (arg === '--poll-ms') options.pollMs = Number(argv[++index] || options.pollMs);
  }
  if (!options.input || !options.outputDir || !options.manifest || !options.result) {
    throw new Error('--input, --output-dir, --manifest and --result are required');
  }
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
}

function normalizeItem(row) {
  const fileId = String(row.file_id || row.fileId || row.fileid || row.id || '').trim();
  const groupId = String(row.groupid || row.groupId || '').trim();
  const name = row.name || row.fname || row.output_name || `file-${fileId}.otl`;
  const relativePath = row.relativePath || row.path || row.local_path || name;
  return {
    ...row,
    file_id: fileId,
    fileId,
    id: fileId,
    groupid: groupId,
    groupId,
    name,
    relativePath,
    path: row.path || relativePath,
    key: row.key || `${groupId}:${fileId}:${relativePath}`,
  };
}

function assertFixedInput(items) {
  const ids = new Set(items.map((item) => item.file_id));
  const bad = items.filter((item) => {
    const suffix = String(item.suffix || item.source_extension || '').toLowerCase();
    const strategy = String(item.download_strategy || '').toUpperCase();
    const itemType = String(item.item_type || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    return !(suffix === '.otl' || name.endsWith('.otl') || strategy === 'EXPORT_DOCX' || itemType.includes('online_word'));
  });
  if (items.length !== 50) throw new Error(`Expected 50 inputs, got ${items.length}`);
  if (ids.size !== 50) throw new Error(`Expected 50 unique file ids, got ${ids.size}`);
  if (bad.length) throw new Error(`Input contains ${bad.length} non-OTL/AirPage rows`);
}

function outputPathFor(item, outputDir) {
  return resolveOutputPath(outputDir, item, 'EXPORT_DOCX');
}

function validateExistingDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  return validateDocx(buffer);
}

function compactResult(item, result, attempt, outputPath, durationMs) {
  const preload = (result.timeline || []).find((entry) => entry.step === 'preload') || {};
  const poll = (result.timeline || []).find((entry) => entry.step === 'result') || {};
  const validation = result.validation || (fs.existsSync(outputPath) ? validateExistingDocx(outputPath) : null);
  return {
    schemaVersion: 1,
    implementation: 'new',
    fileId: item.file_id,
    groupId: item.groupid || '',
    name: item.name || '',
    relativePath: item.relativePath || item.path || '',
    sourceType: item.item_type || item.type || item.ftype || '',
    strategy: 'EXPORT_DOCX',
    attempts: attempt,
    status: result.status || (result.ok ? 'success' : 'failed'),
    ok: Boolean(result.ok),
    errorStage: result.error_stage || '',
    errorCode: result.error_code || '',
    errorMessage: result.error_message || '',
    exportCreateStatus: preload.status || '',
    pollCount: result.export?.poll_count || result.poll_count || poll.poll_count || '',
    pollFinalStatus: poll.api_status || result.api_status || '',
    outputPath: result.output_path || outputPath,
    outputFileName: path.basename(result.output_path || outputPath),
    outputExtension: path.extname(result.output_path || outputPath).toLowerCase(),
    fileSize: validation?.size || 0,
    durationMs,
    validationResult: validation,
    fver: result.metadata?.fver || '',
    ftype: result.metadata?.ftype || '',
    downloadUrlHost: result.export?.download_url_host || '',
    downloadUrlPath: result.export?.download_url_path || '',
  };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
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

async function runOne(item, options, exporter, manifest) {
  const outputPath = outputPathFor(item, options.outputDir);
  let finalRecord = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    await manifest.append({
      key: item.key,
      groupId: item.groupid || '',
      fileId: item.file_id,
      name: item.name || '',
      relativePath: item.relativePath || item.path || '',
      status: FILE_STATUS.RUNNING,
      strategy: 'EXPORT_DOCX',
      attempts: attempt,
      outputPath,
      startedAt,
    });
    const result = await exporter.exportFile(item, { outputPath });
    const durationMs = Date.now() - started;
    finalRecord = compactResult(item, result, attempt, outputPath, durationMs);
    await manifest.append({
      key: item.key,
      groupId: item.groupid || '',
      fileId: item.file_id,
      name: item.name || '',
      relativePath: item.relativePath || item.path || '',
      status: finalRecord.ok ? FILE_STATUS.SUCCESS : FILE_STATUS.FAILED,
      strategy: 'EXPORT_DOCX',
      attempts: attempt,
      outputPath: finalRecord.outputPath,
      errorStage: finalRecord.errorStage,
      errorCode: finalRecord.errorCode,
      validationPass: Boolean(finalRecord.validationResult?.pass),
      fileSize: finalRecord.fileSize,
      finishedAt: new Date().toISOString(),
    });
    if (finalRecord.ok && finalRecord.validationResult?.pass) break;
  }
  return finalRecord;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.concurrency !== 1) throw new Error('Gate 4 requires --concurrency 1');
  if (options.attempts !== 2) throw new Error('Gate 4 requires --attempts 2');
  const items = readJsonl(options.input).map(normalizeItem);
  assertFixedInput(items);
  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(options.result), { recursive: true });
  fs.writeFileSync(options.result, '', 'utf8');
  const manifest = new ManifestStore(options.manifest).load();
  const exporter = new AirPageDocxExporter({ timeoutMs: options.timeoutMs, pollMs: options.pollMs });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results = await runPool(items, options.concurrency, (item) => runOne(item, options, exporter, manifest));
  await manifest.flush();
  for (const record of results) {
    fs.appendFileSync(options.result, `${JSON.stringify(record)}\n`, 'utf8');
  }
  const durations = results.map((record) => Number(record.durationMs || 0)).filter((value) => value >= 0);
  const summary = {
    schemaVersion: 1,
    implementation: 'new',
    inputPath: path.resolve(options.input),
    outputDir: path.resolve(options.outputDir),
    manifestPath: path.resolve(options.manifest),
    resultPath: path.resolve(options.result),
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - started,
    inputCount: items.length,
    uniqueFileIdCount: new Set(items.map((item) => item.file_id)).size,
    processedCount: results.length,
    successCount: results.filter((record) => record.ok && record.validationResult?.pass).length,
    failedCount: results.filter((record) => !(record.ok && record.validationResult?.pass)).length,
    validationPassCount: results.filter((record) => record.validationResult?.pass).length,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    medianDurationMs: percentile(durations, 0.5),
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    attempt1SuccessCount: results.filter((record) => record.ok && record.attempts === 1).length,
    attempt2SuccessCount: results.filter((record) => record.ok && record.attempts === 2).length,
    totalCreateErrors: results.filter((record) => record.errorStage === 'preload').length,
    totalPollErrors: results.filter((record) => record.errorStage === 'result').length,
    totalTimeouts: results.filter((record) => String(record.errorCode || '').includes('TIMEOUT')).length,
    totalDownloadErrors: results.filter((record) => record.errorStage === 'download').length,
    totalValidationErrors: results.filter((record) => record.errorStage === 'download' && !record.validationResult?.pass).length,
    results,
  };
  const summaryPath = path.join(path.dirname(options.result), 'new-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: summary.successCount === 50 && summary.failedCount === 0 && summary.validationPassCount === 50,
    summaryPath,
    resultPath: path.resolve(options.result),
    successCount: summary.successCount,
    failedCount: summary.failedCount,
    validationPassCount: summary.validationPassCount,
    totalDurationMs: summary.totalDurationMs,
  }, null, 2));
  if (!(summary.successCount === 50 && summary.failedCount === 0 && summary.validationPassCount === 50)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
});
