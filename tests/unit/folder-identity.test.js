'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKDocsUrl } = require('../../src/kdocs/folder-identity');

test('parse enterprise root URL', () => {
  const identity = parseKDocsUrl('https://365.kdocs.cn/ent/689144670/2531747480');
  assert.equal(identity.kind, 'ent');
  assert.equal(identity.orgId, '689144670');
  assert.equal(identity.groupId, '2531747480');
  assert.equal(identity.parentId, '-2531747480');
});

test('parse enterprise subfolder URL', () => {
  const identity = parseKDocsUrl('https://365.kdocs.cn/ent/689144670/2531747480/413855229496');
  assert.equal(identity.parentId, '413855229496');
});

