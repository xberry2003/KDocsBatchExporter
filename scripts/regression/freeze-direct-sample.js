#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = { scans: [], output: '', limit: 40, maxSize: 80 * 1024 * 1024, largeSize: 10 * 1024 * 1024 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scan') options.scans.push(argv[++index] || '');
    else if (arg === '--output') options.output = argv[++index] || '';
    else if (arg === '--limit') options.limit = Number(argv[++index] || options.limit);
    else if (arg === '--max-size-mb') options.maxSize = Number(argv[++index] || 80) * 1024 * 1024;
    else if (arg === '--large-size-mb') options.largeSize = Number(argv[++index] || 10) * 1024 * 1024;
  }
  if (!options.scans.length || !options.output) throw new Error('--scan and --output are required');
  return options;
}

function extOf(name) {
  return (String(name || '').toLowerCase().match(/(\.[^.]+)$/) || [''])[0];
}

function categoryOf(file) {
  const ext = extOf(file.name);
  if (ext === '.otl') return 'EXCLUDED_OTL';
  if (ext === '.form') return 'EXCLUDED_FORM';
  if (ext === '.pdf') return 'PDF';
  if (ext === '.ppt' || ext === '.pptx') return 'PRESENTATION';
  if (ext === '.xls' || ext === '.xlsx') return 'SPREADSHEET';
  return 'OTHER_FILE';
}

function readFiles(scanPath) {
  const summary = { sourceUrl: '', rootId: '', groupId: '' };
  const files = [];
  for (const line of fs.readFileSync(scanPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.recordType === 'scan_summary') {
      summary.sourceUrl = row.sourceUrl || '';
      summary.rootId = row.rootId || '';
      summary.groupId = row.groupId || '';
    } else if (row.recordType === 'file') {
      files.push({
        id: String(row.id || ''),
        groupId: String(row.groupId || ''),
        parentId: String(row.parentId || ''),
        name: row.name || path.basename(row.relativePath || ''),
        relativePath: row.relativePath || row.name || '',
        fileType: row.fileType || '',
        size: Number(row.size || 0),
        linkUrlPresent: Boolean(row.linkUrlPresent),
        rootFolderId: summary.rootId,
        sourceUrl: summary.sourceUrl,
      });
    }
  }
  return files;
}

function takeByCategory(files, category, count, selected, used) {
  const candidates = files
    .filter((file) => categoryOf(file) === category && !used.has(`${file.groupId}:${file.id}`))
    .sort((a, b) => a.size - b.size);
  for (const file of candidates.slice(0, count)) {
    selected.push(file);
    used.add(`${file.groupId}:${file.id}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const all = options.scans.flatMap(readFiles);
  const excludedOtlCount = all.filter((file) => categoryOf(file) === 'EXCLUDED_OTL').length;
  const excludedFormCount = all.filter((file) => categoryOf(file) === 'EXCLUDED_FORM').length;
  const direct = all.filter((file) => !categoryOf(file).startsWith('EXCLUDED_') && file.size <= options.maxSize);
  const selected = [];
  const used = new Set();

  takeByCategory(direct, 'PDF', 8, selected, used);
  takeByCategory(direct, 'PRESENTATION', 6, selected, used);
  takeByCategory(direct, 'SPREADSHEET', 6, selected, used);
  takeByCategory(direct, 'OTHER_FILE', 20, selected, used);

  const largeCandidates = direct
    .filter((file) => file.size >= options.largeSize && !used.has(`${file.groupId}:${file.id}`))
    .sort((a, b) => b.size - a.size)
    .slice(0, 3);
  for (const file of largeCandidates) {
    const replaceIndex = selected.findIndex((item) => categoryOf(item) === categoryOf(file) && item.size < options.largeSize);
    if (replaceIndex >= 0) {
      used.delete(`${selected[replaceIndex].groupId}:${selected[replaceIndex].id}`);
      selected[replaceIndex] = file;
      used.add(`${file.groupId}:${file.id}`);
    }
  }

  for (const file of direct.sort((a, b) => a.size - b.size)) {
    if (selected.length >= options.limit) break;
    const key = `${file.groupId}:${file.id}`;
    if (used.has(key)) continue;
    selected.push(file);
    used.add(key);
  }

  const outputPath = path.resolve(options.output);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = selected.slice(0, options.limit).map((file) => ({
    schemaVersion: 2,
    recordType: 'direct_sample',
    id: file.id,
    fileId: file.id,
    groupId: file.groupId,
    parentId: file.parentId,
    name: file.name,
    relativePath: file.relativePath,
    fileType: file.fileType,
    size: file.size,
    linkUrlPresent: file.linkUrlPresent,
    rootFolderId: file.rootFolderId,
    sourceUrl: file.sourceUrl,
    category: categoryOf(file),
    extension: extOf(file.name),
  }));
  await fs.promises.writeFile(outputPath, `${lines.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const distribution = {};
  const extensions = {};
  for (const row of lines) {
    distribution[row.category] = (distribution[row.category] || 0) + 1;
    extensions[row.extension || '<none>'] = (extensions[row.extension || '<none>'] || 0) + 1;
  }
  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    sampleCount: lines.length,
    excludedOtlCount,
    excludedFormCount,
    distribution,
    extensions,
    linkUrlPresentCount: lines.filter((row) => row.linkUrlPresent).length,
    largeFileCount: lines.filter((row) => row.size >= options.largeSize).length,
    totalBytes: lines.reduce((sum, row) => sum + row.size, 0),
    maxSizeMb: Math.round(options.maxSize / 1024 / 1024),
    minSize: Math.min(...lines.map((row) => row.size)),
    maxSize: Math.max(...lines.map((row) => row.size)),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
});
