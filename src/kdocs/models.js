'use strict';

function stringValue(value) {
  return value == null ? '' : String(value);
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFolderType(fileType) {
  return String(fileType || '').toLowerCase() === 'folder';
}

function normalizeKDocsItem(source = {}, context = {}) {
  const id = stringValue(source.id || source.fileid || source.file_id);
  const groupId = stringValue(source.groupid || source.groupId || context.groupId);
  const parentId = stringValue(source.parentid || source.parentId || context.parentId);
  const name = stringValue(source.fname || source.name || context.name);
  const fileType = stringValue(source.ftype || source.fileType || source.type);
  const relativePath = stringValue(context.relativePath || source.relativePath || source.path);
  const linkUrl = stringValue(source.link_url || source.linkUrl);
  const sourceUrl = stringValue(context.sourceUrl || source.sourceUrl);

  return {
    id,
    groupId,
    parentId,
    name,
    fileType,
    size: numberValue(source.fsize ?? source.size),
    linkUrl,
    sourceUrl,
    relativePath,
    isFolder: isFolderType(fileType),
    linkId: stringValue(source.link_id || source.linkid || source.linkId),
    corpId: stringValue(
      source.corpid ||
      source.corp_id ||
      source.creator?.corpid ||
      source.modifier?.corpid ||
      source.file_perms_acl?.corpid
    ),
    sourceMetadata: { ...source },
  };
}

function itemKey(item = {}) {
  const groupId = stringValue(item.groupId || item.groupid);
  const id = stringValue(item.id || item.fileId || item.file_id);
  return `${groupId}:${id}`;
}

module.exports = {
  isFolderType,
  itemKey,
  normalizeKDocsItem,
};

