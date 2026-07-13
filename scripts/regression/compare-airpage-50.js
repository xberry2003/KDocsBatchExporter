#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DIFF_TYPES = [
  'MISSING_IN_NEW',
  'EXTRA_IN_NEW',
  'GOLDEN_SUCCESS_NEW_FAILED',
  'OUTPUT_EXTENSION_MISMATCH',
  'OUTPUT_PATH_MISMATCH',
  'VALIDATION_MISMATCH',
  'AIRPAGE_IDENTITY_MISMATCH',
  'FILE_ID_MAPPING_MISMATCH',
  'DUPLICATE_OUTPUT_PATH',
  'DUPLICATE_FILE_ID',
  'MANIFEST_MISSING_ITEM',
];

function parseArgs(argv) {
  const options = { input: '', goldenManifest: '', next: '', newManifest: '', output: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') options.input = argv[++index] || '';
    else if (arg === '--golden-manifest') options.goldenManifest = argv[++index] || '';
    else if (arg === '--new') options.next = argv[++index] || '';
    else if (arg === '--new-manifest') options.newManifest = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
  }
  if (!options.input || !options.goldenManifest || !options.next || !options.newManifest || !options.output) {
    throw new Error('--input, --golden-manifest, --new, --new-manifest and --output are required');
  }
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
}

function fileIdOf(record) {
  return String(record.fileId || record.file_id || record.fileid || record.id || '');
}

function latestSuccessByFileId(records) {
  const map = new Map();
  for (const record of records) {
    if (String(record.status || '') === 'success') {
      map.set(fileIdOf(record), record);
    }
  }
  return map;
}

function latestByFileId(records) {
  const map = new Map();
  for (const record of records) map.set(fileIdOf(record), record);
  return map;
}

function relativeOutputPath(record) {
  return String(record.relativePath || record.path || '').replace(/\.[^.\\/]+$/, '.docx');
}

function pushIf(condition, differences, type, payload) {
  if (condition) differences[type].push(payload);
}

function main() {
  const options = parseArgs(process.argv);
  const input = readJsonl(options.input);
  const golden = readJsonl(options.goldenManifest);
  const next = readJsonl(options.next);
  const newManifest = readJsonl(options.newManifest);
  const expectedIds = input.map(fileIdOf);
  const goldenSuccess = latestSuccessByFileId(golden);
  const newLatest = latestByFileId(next);
  const newSuccess = latestSuccessByFileId(next);
  const manifestLatest = latestByFileId(newManifest);
  const differences = Object.fromEntries(DIFF_TYPES.map((type) => [type, []]));

  for (const id of expectedIds) {
    const g = goldenSuccess.get(id);
    const n = newLatest.get(id);
    if (!n) differences.MISSING_IN_NEW.push({ fileId: id });
    if (g && n && !(n.ok && n.validationResult?.pass)) {
      differences.GOLDEN_SUCCESS_NEW_FAILED.push({
        fileId: id,
        newStatus: n.status || '',
        errorStage: n.errorStage || '',
        errorCode: n.errorCode || '',
      });
    }
    if (n && String(n.outputExtension || '').toLowerCase() !== '.docx') {
      differences.OUTPUT_EXTENSION_MISMATCH.push({ fileId: id, outputExtension: n.outputExtension || '' });
    }
    if (g && n && relativeOutputPath(g) !== relativeOutputPath(n)) {
      differences.OUTPUT_PATH_MISMATCH.push({ fileId: id, golden: relativeOutputPath(g), new: relativeOutputPath(n) });
    }
    if (g && n && Boolean(g.docx_valid || g.validationPass || g.validationResult?.pass) !== Boolean(n.validationResult?.pass)) {
      differences.VALIDATION_MISMATCH.push({ fileId: id, golden: true, new: Boolean(n.validationResult?.pass) });
    }
    if (g && n && String(g.file_id || g.fileId || '') !== String(n.fileId || '')) {
      differences.FILE_ID_MAPPING_MISMATCH.push({ fileId: id, golden: g.file_id || g.fileId || '', new: n.fileId || '' });
    }
    if (g && n && String(g.download_url_host || '') && String(n.downloadUrlHost || '') && String(g.download_url_host || '') !== String(n.downloadUrlHost || '')) {
      differences.AIRPAGE_IDENTITY_MISMATCH.push({ fileId: id, golden: g.download_url_host || '', new: n.downloadUrlHost || '' });
    }
    if (!manifestLatest.has(id)) differences.MANIFEST_MISSING_ITEM.push({ fileId: id });
  }

  for (const id of newLatest.keys()) {
    if (!expectedIds.includes(id)) differences.EXTRA_IN_NEW.push({ fileId: id });
  }

  const outputPaths = new Map();
  for (const record of next) {
    const outputPath = String(record.outputPath || '').toLowerCase();
    if (!outputPath) continue;
    if (!outputPaths.has(outputPath)) outputPaths.set(outputPath, []);
    outputPaths.get(outputPath).push(record.fileId);
  }
  for (const [outputPath, ids] of outputPaths) {
    if (new Set(ids).size > 1) differences.DUPLICATE_OUTPUT_PATH.push({ outputPath, fileIds: ids });
  }

  const idCounts = new Map();
  for (const id of expectedIds) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) differences.DUPLICATE_FILE_ID.push({ fileId: id, count });
  }

  const counts = Object.fromEntries(DIFF_TYPES.map((type) => [type, differences[type].length]));
  const pass = input.length === 50 &&
    new Set(expectedIds).size === 50 &&
    newSuccess.size === 50 &&
    Object.values(counts).every((count) => count === 0);
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gate: 'gate4_fixed_50_otl_formal_regression',
    pass,
    markers: pass ? ['FIXED_50_OTL_FORMAL_REGRESSION_PASS', '第4门 PASS'] : ['GATE_4_FAILED'],
    inputCount: input.length,
    uniqueFileIdCount: new Set(expectedIds).size,
    goldenSuccessCount: goldenSuccess.size,
    newResultCount: next.length,
    newSuccessCount: newSuccess.size,
    counts,
    differences,
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: pass, output: path.resolve(options.output), counts, markers: output.markers }, null, 2));
  if (!pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
}
