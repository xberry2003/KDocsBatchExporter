'use strict';

const path = require('path');

const ITEM_TYPE = Object.freeze({
  AIRPAGE_ONLINE_DOCUMENT: 'AIRPAGE_ONLINE_DOCUMENT',
  PDF: 'PDF',
  PPT: 'PPT',
  PPTX: 'PPTX',
  XLS: 'XLS',
  XLSX: 'XLSX',
  OTHER_FILE: 'OTHER_FILE',
  UNKNOWN: 'UNKNOWN',
});

function extensionOf(item = {}) {
  const name = String(item.name || item.fname || '').trim();
  return path.extname(name).toLowerCase();
}

function metadataText(item = {}) {
  const raw = {
    fileType: item.fileType || item.type || item.ftype || item.rawFtype || '',
    metadata: item.sourceMetadata || item.metadata || item.meta || {},
  };
  return JSON.stringify(raw).toLowerCase();
}

function isAirPageOnlineDocument(item = {}) {
  const ext = extensionOf(item);
  const text = metadataText(item);
  if (ext === '.otl') return true;
  return /otl|writer|wpsdoc|online.*doc|docx_export|word_document|wps文字|文字文档/.test(text);
}

function detectFileType(item = {}) {
  const ext = extensionOf(item);
  const text = metadataText(item);

  if (isAirPageOnlineDocument(item)) return ITEM_TYPE.AIRPAGE_ONLINE_DOCUMENT;
  if (ext === '.pdf' || /\bpdf\b/.test(text)) return ITEM_TYPE.PDF;
  if (ext === '.pptx') return ITEM_TYPE.PPTX;
  if (ext === '.ppt') return ITEM_TYPE.PPT;
  if (/\bpptx?\b|presentation/.test(text)) return ITEM_TYPE.PPTX;
  if (ext === '.xlsx') return ITEM_TYPE.XLSX;
  if (ext === '.xls') return ITEM_TYPE.XLS;
  if (/\bxlsx?\b|sheet|spreadsheet/.test(text)) return ITEM_TYPE.XLSX;
  if (ext) return ITEM_TYPE.OTHER_FILE;
  return ITEM_TYPE.UNKNOWN;
}

module.exports = {
  ITEM_TYPE,
  detectFileType,
  extensionOf,
  isAirPageOnlineDocument,
};

