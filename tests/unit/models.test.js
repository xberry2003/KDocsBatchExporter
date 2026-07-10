'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { itemKey, normalizeKDocsItem } = require('../../src/kdocs/models');

test('normalizeKDocsItem preserves proven KDocs fields', () => {
  const source = {
    id: 123,
    groupid: 456,
    parentid: -456,
    fname: '报告.pdf',
    ftype: 'file',
    fsize: 99,
    link_url: 'https://example.invalid/link',
  };
  const item = normalizeKDocsItem(source, {
    sourceUrl: 'https://365.kdocs.cn/ent/1/456',
    relativePath: '目录/报告.pdf',
  });

  assert.equal(item.id, '123');
  assert.equal(item.groupId, '456');
  assert.equal(item.parentId, '-456');
  assert.equal(item.name, '报告.pdf');
  assert.equal(item.size, 99);
  assert.equal(item.relativePath, '目录/报告.pdf');
  assert.equal(item.linkUrl, source.link_url);
  assert.deepEqual(item.sourceMetadata, source);
  assert.equal(itemKey(item), '456:123');
});

