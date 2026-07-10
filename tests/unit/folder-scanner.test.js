'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KDocsFolderScanner } = require('../../src/kdocs/folder-scanner');

test('scanner traverses folders and deduplicates file identities', async () => {
  const tree = new Map([
    ['-9', [
      { id: '10', groupId: '9', name: 'A', fileType: 'folder', isFolder: true },
      { id: '20', groupId: '9', name: 'root.pdf', fileType: 'file', isFolder: false },
    ]],
    ['10', [
      { id: '21', groupId: '9', name: 'child.pptx', fileType: 'file', isFolder: false },
      { id: '20', groupId: '9', name: 'duplicate.pdf', fileType: 'file', isFolder: false },
    ]],
  ]);
  const apiClient = {
    async listFolderFiles(groupId, parentId) {
      return tree.get(String(parentId)) || [];
    },
  };
  const scanner = new KDocsFolderScanner({ apiClient });
  const result = await scanner.scan({
    groupId: '9',
    parentId: '-9',
    sourceUrl: 'https://365.kdocs.cn/ent/1/9',
  });

  assert.equal(result.stats.folderCount, 2);
  assert.equal(result.stats.fileCount, 2);
  assert.deepEqual(result.files.map((file) => file.id).sort(), ['20', '21']);
  assert.equal(result.files.find((file) => file.id === '21').relativePath, 'A/child.pptx');
});

