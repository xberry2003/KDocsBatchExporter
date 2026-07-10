'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ITEM_TYPE,
  detectFileType,
  isAirPageOnlineDocument,
} = require('../../src/kdocs/file-type-detector');
const { DOWNLOAD_STRATEGY, resolveStrategy } = require('../../src/download/router');

test('detects OTL as AirPage online document', () => {
  const item = { name: '方案.otl', fileType: 'file' };
  assert.equal(isAirPageOnlineDocument(item), true);
  assert.equal(detectFileType(item), ITEM_TYPE.AIRPAGE_ONLINE_DOCUMENT);
  assert.equal(resolveStrategy(item), DOWNLOAD_STRATEGY.EXPORT_DOCX);
});

test('detects common direct-download types', () => {
  assert.equal(detectFileType({ name: '报告.pdf' }), ITEM_TYPE.PDF);
  assert.equal(detectFileType({ name: '汇报.ppt' }), ITEM_TYPE.PPT);
  assert.equal(detectFileType({ name: '汇报.pptx' }), ITEM_TYPE.PPTX);
  assert.equal(detectFileType({ name: '表格.xls' }), ITEM_TYPE.XLS);
  assert.equal(detectFileType({ name: '表格.xlsx' }), ITEM_TYPE.XLSX);
  assert.equal(resolveStrategy({ name: '报告.pdf' }), DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD);
});

test('unknown without name is skipped', () => {
  assert.equal(detectFileType({}), ITEM_TYPE.UNKNOWN);
  assert.equal(resolveStrategy({}), DOWNLOAD_STRATEGY.SKIP);
});

