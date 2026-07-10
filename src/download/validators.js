'use strict';

const fs = require('fs');
const AdmZip = require('adm-zip');

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function failure(format, code, details = {}) {
  return { pass: false, format, code, ...details };
}

function success(format, details = {}) {
  return { pass: true, format, code: '', ...details };
}

function zipEntryNames(buffer) {
  try {
    return new AdmZip(buffer).getEntries().map((entry) => entry.entryName);
  } catch (error) {
    return { error: error.message };
  }
}

function validateZipOffice(buffer, format, requiredEntries) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return failure(format, 'EMPTY_FILE', { size: buffer?.length || 0 });
  }
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    return failure(format, 'NOT_ZIP', { size: buffer.length });
  }
  const entries = zipEntryNames(buffer);
  if (!Array.isArray(entries)) {
    return failure(format, 'INVALID_ZIP', { size: buffer.length, zip_error: entries.error });
  }
  const missingEntries = requiredEntries.filter((entry) => !entries.includes(entry));
  if (missingEntries.length) {
    return failure(format, 'MISSING_REQUIRED_ENTRIES', {
      size: buffer.length,
      missing_entries: missingEntries,
      entry_count: entries.length,
    });
  }
  return success(format, { size: buffer.length, entry_count: entries.length });
}

function validateDocx(buffer) {
  return validateZipOffice(buffer, 'docx', [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
  ]);
}

function validatePptx(buffer) {
  return validateZipOffice(buffer, 'pptx', [
    '[Content_Types].xml',
    'ppt/presentation.xml',
  ]);
}

function validateXlsx(buffer) {
  return validateZipOffice(buffer, 'xlsx', [
    '[Content_Types].xml',
    'xl/workbook.xml',
  ]);
}

function validatePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return failure('pdf', 'EMPTY_FILE', { size: buffer?.length || 0 });
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    ? success('pdf', { size: buffer.length })
    : failure('pdf', 'INVALID_PDF_MAGIC', { size: buffer.length });
}

function validateOle(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return failure(format, 'EMPTY_FILE', { size: buffer?.length || 0 });
  return buffer.subarray(0, 8).equals(OLE_MAGIC)
    ? success(format, { size: buffer.length })
    : failure(format, 'INVALID_OLE_MAGIC', { size: buffer.length });
}

function validateOther(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 0
    ? success('other', { size: buffer.length })
    : failure('other', 'EMPTY_FILE', { size: buffer?.length || 0 });
}

function validateBuffer(buffer, fileType) {
  switch (String(fileType || '').toLowerCase()) {
    case 'docx':
    case 'airpage_online_document':
      return validateDocx(buffer);
    case 'pdf':
      return validatePdf(buffer);
    case 'pptx':
      return validatePptx(buffer);
    case 'ppt':
      return validateOle(buffer, 'ppt');
    case 'xlsx':
      return validateXlsx(buffer);
    case 'xls':
      return validateOle(buffer, 'xls');
    default:
      return validateOther(buffer);
  }
}

function validateFile(filePath, fileType) {
  if (!fs.existsSync(filePath)) return failure(fileType || 'other', 'FILE_NOT_FOUND', { file_path: filePath });
  return validateBuffer(fs.readFileSync(filePath), fileType);
}

module.exports = {
  validateBuffer,
  validateDocx,
  validateFile,
  validateOther,
  validatePdf,
  validatePptx,
  validateXlsx,
  validateOle,
  zipEntryNames,
};

