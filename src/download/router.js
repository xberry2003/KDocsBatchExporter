'use strict';

const { ITEM_TYPE, detectFileType } = require('../kdocs/file-type-detector');

const DOWNLOAD_STRATEGY = Object.freeze({
  DIRECT_DOWNLOAD: 'DIRECT_DOWNLOAD',
  EXPORT_DOCX: 'EXPORT_DOCX',
  SKIP: 'SKIP',
});

function resolveStrategy(item = {}) {
  const fileType = detectFileType(item);
  if (fileType === ITEM_TYPE.AIRPAGE_ONLINE_DOCUMENT) return DOWNLOAD_STRATEGY.EXPORT_DOCX;
  if (fileType === ITEM_TYPE.UNKNOWN) return DOWNLOAD_STRATEGY.SKIP;
  return DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD;
}

module.exports = {
  DOWNLOAD_STRATEGY,
  resolveStrategy,
};

