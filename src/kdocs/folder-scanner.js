'use strict';

const path = require('path');
const { itemKey } = require('./models');

function joinRelativePath(parent, child) {
  return [parent, child].filter(Boolean).join('/');
}

class KDocsFolderScanner {
  constructor(options = {}) {
    if (!options.apiClient) throw new Error('KDocsFolderScanner requires apiClient');
    this.apiClient = options.apiClient;
  }

  async scan(identity, options = {}) {
    const traversal = options.traversal === 'queue' ? 'queue' : 'stack';
    const maxFolders = Number.isFinite(options.maxFolders) ? options.maxFolders : Number.MAX_SAFE_INTEGER;
    const rootName = options.rootName || path.basename(new URL(identity.sourceUrl).pathname) || identity.groupId;
    const root = {
      id: String(identity.parentId),
      groupId: String(identity.groupId),
      parentId: '',
      name: rootName,
      fileType: 'folder',
      size: 0,
      linkUrl: '',
      sourceUrl: identity.sourceUrl,
      relativePath: '',
      isFolder: true,
      sourceMetadata: {},
    };

    const pending = [{ folder: root, relativePath: '' }];
    const visitedFolders = new Set();
    const itemIds = new Set();
    const folders = [];
    const files = [];
    let apiRequestCount = 0;

    while (pending.length && visitedFolders.size < maxFolders) {
      const current = traversal === 'queue' ? pending.shift() : pending.pop();
      const folderKey = itemKey(current.folder);
      if (!current.folder.id || visitedFolders.has(folderKey)) continue;
      visitedFolders.add(folderKey);
      folders.push({ ...current.folder, relativePath: current.relativePath });

      const children = await this.apiClient.listFolderFiles(
        current.folder.groupId || identity.groupId,
        current.folder.id,
        { sourceUrl: identity.sourceUrl }
      );
      apiRequestCount += 1;

      for (const child of children) {
        const childPath = joinRelativePath(current.relativePath, child.name);
        const normalized = { ...child, relativePath: childPath };
        const key = itemKey(normalized);
        if (!normalized.id || itemIds.has(key)) continue;
        itemIds.add(key);

        if (normalized.isFolder) {
          pending.push({
            folder: normalized,
            relativePath: childPath,
          });
        } else {
          files.push(normalized);
        }
      }

      if (typeof options.onProgress === 'function') {
        options.onProgress({
          visitedFolderCount: visitedFolders.size,
          discoveredFolderCount: folders.length + pending.length,
          discoveredFileCount: files.length,
          apiRequestCount,
        });
      }
    }

    return {
      identity: { ...identity },
      root,
      folders,
      files,
      stats: {
        folderCount: folders.length,
        fileCount: files.length,
        visitedFolderCount: visitedFolders.size,
        pendingFolderCount: pending.length,
        apiRequestCount,
        truncated: pending.length > 0,
      },
    };
  }
}

module.exports = { KDocsFolderScanner, joinRelativePath };

