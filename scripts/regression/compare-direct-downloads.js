#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TYPES = [
  'GOLDEN_SUCCESS_NEW_FAILED',
  'GOLDEN_FAILED_NEW_SUCCESS',
  'BOTH_FAILED_SAME_STAGE',
  'BOTH_FAILED_DIFFERENT_STAGE',
  'OUTPUT_EXTENSION_MISMATCH',
  'PATH_MISMATCH',
  'FILE_SIZE_MISMATCH',
  'VALIDATION_MISMATCH',
  'BINARY_HASH_MISMATCH',
  'ATTEMPT_BEHAVIOR_MISMATCH',
];

function parseArgs(argv) {
  const options = { golden: '', next: '', output: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--golden') options.golden = argv[++index] || '';
    else if (arg === '--new') options.next = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
  }
  if (!options.golden || !options.next || !options.output) throw new Error('--golden, --new and --output are required');
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function keyOf(record) {
  return `${record.groupId}:${record.fileId}`;
}

function main() {
  const options = parseArgs(process.argv);
  const golden = new Map(readJsonl(options.golden).map((record) => [keyOf(record), record]));
  const next = new Map(readJsonl(options.next).map((record) => [keyOf(record), record]));
  const differences = Object.fromEntries(TYPES.map((type) => [type, []]));

  for (const [key, g] of golden) {
    const n = next.get(key);
    if (!n) {
      differences.GOLDEN_SUCCESS_NEW_FAILED.push({ key, golden: g.status, new: 'missing' });
      continue;
    }
    const gSuccess = g.status === 'success';
    const nSuccess = n.status === 'success';
    if (gSuccess && !nSuccess) differences.GOLDEN_SUCCESS_NEW_FAILED.push({ key, name: g.name, newStatus: n.status, errorStage: n.errorStage });
    if (!gSuccess && nSuccess) differences.GOLDEN_FAILED_NEW_SUCCESS.push({ key, name: g.name, goldenStage: g.errorStage });
    if (!gSuccess && !nSuccess && (g.errorStage || '') === (n.errorStage || '')) differences.BOTH_FAILED_SAME_STAGE.push({ key, stage: g.errorStage || '' });
    if (!gSuccess && !nSuccess && (g.errorStage || '') !== (n.errorStage || '')) differences.BOTH_FAILED_DIFFERENT_STAGE.push({ key, golden: g.errorStage || '', new: n.errorStage || '' });
    if ((g.outputExtension || '') !== (n.outputExtension || '')) differences.OUTPUT_EXTENSION_MISMATCH.push({ key, golden: g.outputExtension, new: n.outputExtension });
    if ((g.relativePath || '') !== (n.relativePath || '')) differences.PATH_MISMATCH.push({ key, golden: g.relativePath, new: n.relativePath });
    if (gSuccess && nSuccess && Number(g.fileSize || 0) !== Number(n.fileSize || 0)) differences.FILE_SIZE_MISMATCH.push({ key, golden: g.fileSize, new: n.fileSize });
    if (Boolean(g.validationResult?.pass) !== Boolean(n.validationResult?.pass)) differences.VALIDATION_MISMATCH.push({ key, golden: g.validationResult, new: n.validationResult });
    if (gSuccess && nSuccess && g.sha256 && n.sha256 && g.sha256 !== n.sha256) differences.BINARY_HASH_MISMATCH.push({ key, name: g.name, golden: g.sha256, new: n.sha256 });
    if (n.downloadUrlRequestCount && n.attempts && n.downloadUrlRequestCount !== n.attempts) differences.ATTEMPT_BEHAVIOR_MISMATCH.push({ key, attempts: n.attempts, downloadUrlRequestCount: n.downloadUrlRequestCount });
  }

  const counts = Object.fromEntries(TYPES.map((type) => [type, differences[type].length]));
  const hardPass = counts.GOLDEN_SUCCESS_NEW_FAILED === 0;
  const pass = hardPass &&
    counts.OUTPUT_EXTENSION_MISMATCH === 0 &&
    counts.PATH_MISMATCH === 0 &&
    counts.FILE_SIZE_MISMATCH === 0 &&
    counts.VALIDATION_MISMATCH === 0 &&
    counts.BINARY_HASH_MISMATCH === 0 &&
    counts.ATTEMPT_BEHAVIOR_MISMATCH === 0;
  const output = {
    pass,
    hardPass,
    generatedAt: new Date().toISOString(),
    goldenCount: golden.size,
    newCount: next.size,
    counts,
    differences,
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: pass, hard_pass: hardPass, output: path.resolve(options.output), counts }, null, 2));
  if (!pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
}

