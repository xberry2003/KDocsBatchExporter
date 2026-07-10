'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  outputNameFor,
  replaceExtension,
  resolveOutputPath,
  sanitizeSegment,
} = require('../../src/download/output-path-resolver');

test('OTL becomes DOCX without double extension', () => {
  assert.equal(replaceExtension('项目方案.otl', '.docx'), '项目方案.docx');
  assert.equal(replaceExtension('项目方案.docx', '.docx'), '项目方案.docx');
  assert.equal(outputNameFor({ name: '项目方案.otl' }, 'EXPORT_DOCX'), '项目方案.docx');
});

test('Windows invalid and reserved names are sanitized', () => {
  assert.equal(sanitizeSegment('a:b?.pdf'), 'a_b_.pdf');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('name. '), 'name');
});

test('relative directory structure is retained', () => {
  const output = resolveOutputPath('D:\\export', {
    id: '1',
    name: '文档.otl',
    relativePath: '一级/二级/文档.otl',
  }, 'EXPORT_DOCX');
  assert.equal(output, path.resolve('D:\\export', '一级', '二级', '文档.docx'));
});

