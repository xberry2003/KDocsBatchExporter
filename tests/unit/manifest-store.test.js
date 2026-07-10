'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FILE_STATUS,
  ManifestStore,
  normalizeLegacyRecord,
} = require('../../src/manifest/manifest-store');

test('normalizes both Golden legacy manifest schemas', () => {
  const direct = normalizeLegacyRecord({
    groupid: '9',
    file_id: '1',
    path: 'A/x.pdf',
    download_strategy: 'DIRECT_DOWNLOAD',
    status: 'success',
  });
  assert.equal(direct.key, '9:1');
  assert.equal(direct.strategy, 'DIRECT_DOWNLOAD');

  const airpage = normalizeLegacyRecord({
    schema_version: 1,
    key: '9:2:A/y.otl',
    file_id: '2',
    output_path: 'A/y.docx',
    docx_valid: true,
    status: 'success',
  });
  assert.equal(airpage.key, '9:2:A/y.otl');
  assert.equal(airpage.validationPass, true);
});

test('interrupted running state is recoverable as pending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdocs-manifest-'));
  const manifestPath = path.join(dir, 'manifest.jsonl');
  const store = new ManifestStore(manifestPath).load();
  await store.append({
    groupId: '9',
    fileId: '1',
    status: FILE_STATUS.RUNNING,
  });
  await store.flush();

  const loaded = new ManifestStore(manifestPath).load();
  const records = loaded.getRecoverableRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, FILE_STATUS.PENDING);
  assert.equal(records[0].recoveredFrom, FILE_STATUS.RUNNING);
});

