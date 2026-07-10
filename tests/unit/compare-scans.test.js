'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

test('compare-scans classifies persistent business mismatches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdocs-compare-'));
  const golden = path.join(dir, 'golden.jsonl');
  const next = path.join(dir, 'new.jsonl');
  const diff = path.join(dir, 'diff.json');
  fs.writeFileSync(golden, [
    JSON.stringify({ recordType: 'scan_summary' }),
    JSON.stringify({ recordType: 'file', id: '1', kind: 'file', groupId: '9', parentId: '8', relativePath: 'A/x.pdf', fileType: 'file', linkUrlPresent: false }),
    JSON.stringify({ recordType: 'folder', id: '2', kind: 'folder', groupId: '9', parentId: '8', relativePath: 'A', fileType: 'folder', linkUrlPresent: false }),
  ].join('\n'));
  fs.writeFileSync(next, [
    JSON.stringify({ recordType: 'scan_summary' }),
    JSON.stringify({ recordType: 'file', id: '1', kind: 'file', groupId: '9', parentId: '7', relativePath: 'B/x.pdf', fileType: 'pdf', linkUrlPresent: true }),
    JSON.stringify({ recordType: 'file', id: '3', kind: 'file', groupId: '9', parentId: '8', relativePath: 'extra.pdf', fileType: 'file', linkUrlPresent: false }),
  ].join('\n'));

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', '..', 'scripts', 'regression', 'compare-scans.js'),
    '--golden', golden,
    '--new', next,
    '--output', diff,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(fs.readFileSync(diff, 'utf8'));
  assert.equal(parsed.mismatchCounts.MISSING_IN_NEW, 1);
  assert.equal(parsed.mismatchCounts.EXTRA_IN_NEW, 1);
  assert.equal(parsed.mismatchCounts.PATH_MISMATCH, 1);
  assert.equal(parsed.mismatchCounts.PARENT_ID_MISMATCH, 1);
  assert.equal(parsed.mismatchCounts.FILE_TYPE_MISMATCH, 1);
  assert.equal(parsed.mismatchCounts.LINK_URL_PRESENCE_MISMATCH, 1);
});

