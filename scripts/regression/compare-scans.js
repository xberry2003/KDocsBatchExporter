#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MISMATCH_TYPES = [
  'MISSING_IN_NEW',
  'EXTRA_IN_NEW',
  'PATH_MISMATCH',
  'GROUP_ID_MISMATCH',
  'FILE_TYPE_MISMATCH',
  'LINK_URL_PRESENCE_MISMATCH',
  'NODE_KIND_MISMATCH',
  'PARENT_ID_MISMATCH',
];

function parseArgs(argv) {
  const options = { golden: '', next: '', output: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--golden') options.golden = argv[++index] || '';
    else if (arg === '--new') options.next = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
  }
  if (!options.golden || !options.next || !options.output) {
    throw new Error('--golden, --new and --output are required');
  }
  return options;
}

function readScan(filePath) {
  const records = [];
  let summary = null;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line.replace(/^\uFEFF/, ''));
    if (record.recordType === 'scan_summary') summary = record;
    else records.push({
      id: String(record.id || ''),
      kind: String(record.kind || record.recordType || ''),
      groupId: String(record.groupId || record.groupid || ''),
      parentId: String(record.parentId || record.parentid || ''),
      relativePath: String(record.relativePath || record.path || '').replace(/\\/g, '/'),
      fileType: String(record.fileType || record.ftype || record.type || ''),
      linkUrlPresent: Boolean(record.linkUrlPresent || record.link_url_present),
    });
  }
  return { summary, records };
}

function compare(goldenScan, newScan) {
  const goldenById = new Map(goldenScan.records.map((record) => [record.id, record]));
  const newById = new Map(newScan.records.map((record) => [record.id, record]));
  const differences = Object.fromEntries(MISMATCH_TYPES.map((type) => [type, []]));

  for (const [id, golden] of goldenById) {
    const next = newById.get(id);
    if (!next) {
      differences.MISSING_IN_NEW.push({ id, golden });
      continue;
    }
    const checks = [
      ['PATH_MISMATCH', 'relativePath'],
      ['GROUP_ID_MISMATCH', 'groupId'],
      ['FILE_TYPE_MISMATCH', 'fileType'],
      ['LINK_URL_PRESENCE_MISMATCH', 'linkUrlPresent'],
      ['NODE_KIND_MISMATCH', 'kind'],
      ['PARENT_ID_MISMATCH', 'parentId'],
    ];
    for (const [type, field] of checks) {
      if (golden[field] !== next[field]) {
        differences[type].push({
          id,
          golden: golden[field],
          new: next[field],
          kind: golden.kind,
          path: golden.relativePath,
        });
      }
    }
  }

  for (const [id, next] of newById) {
    if (!goldenById.has(id)) differences.EXTRA_IN_NEW.push({ id, new: next });
  }

  const mismatchCounts = Object.fromEntries(
    MISMATCH_TYPES.map((type) => [type, differences[type].length])
  );
  const totalMismatches = Object.values(mismatchCounts).reduce((sum, value) => sum + value, 0);
  const goldenFiles = new Set(goldenScan.records.filter((record) => record.kind === 'file').map((record) => record.id));
  const newFiles = new Set(newScan.records.filter((record) => record.kind === 'file').map((record) => record.id));
  const goldenFolders = new Set(goldenScan.records.filter((record) => record.kind === 'folder').map((record) => record.id));
  const newFolders = new Set(newScan.records.filter((record) => record.kind === 'folder').map((record) => record.id));

  return {
    pass: totalMismatches === 0,
    generatedAt: new Date().toISOString(),
    goldenSummary: goldenScan.summary,
    newSummary: newScan.summary,
    setCounts: {
      goldenFileIds: goldenFiles.size,
      newFileIds: newFiles.size,
      goldenFolderIds: goldenFolders.size,
      newFolderIds: newFolders.size,
    },
    mismatchCounts,
    totalMismatches,
    differences,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const result = compare(readScan(options.golden), readScan(options.next));
  const outputPath = path.resolve(options.output);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: result.pass,
    output: outputPath,
    total_mismatches: result.totalMismatches,
    mismatch_counts: result.mismatchCounts,
  }, null, 2));
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error_name: error.name,
    error_message: error.message,
  }, null, 2));
  process.exitCode = 1;
});

