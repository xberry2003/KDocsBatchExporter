'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const {
  validateDocx,
  validateOle,
  validatePdf,
  validatePptx,
  validateXlsx,
} = require('../../src/download/validators');

function makeZip(entries) {
  const zip = new AdmZip();
  for (const entry of entries) zip.addFile(entry, Buffer.from('<xml/>'));
  return zip.toBuffer();
}

test('validates DOCX required entries', () => {
  const valid = makeZip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.equal(validateDocx(valid).pass, true);
  assert.equal(validateDocx(makeZip(['[Content_Types].xml'])).pass, false);
});

test('validates PDF and OLE magic', () => {
  assert.equal(validatePdf(Buffer.from('%PDF-1.7')).pass, true);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
  assert.equal(validateOle(ole, 'ppt').pass, true);
  assert.equal(validateOle(ole, 'xls').pass, true);
});

test('validates PPTX and XLSX required entries', () => {
  assert.equal(validatePptx(makeZip(['[Content_Types].xml', 'ppt/presentation.xml'])).pass, true);
  assert.equal(validateXlsx(makeZip(['[Content_Types].xml', 'xl/workbook.xml'])).pass, true);
});

