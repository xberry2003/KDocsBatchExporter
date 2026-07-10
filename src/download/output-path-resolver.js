'use strict';

const path = require('path');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function sanitizeSegment(value, fallback = 'untitled') {
  let cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!cleaned) cleaned = fallback;
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.slice(0, 180);
}

function replaceExtension(name, extension) {
  const desired = extension.startsWith('.') ? extension : `.${extension}`;
  const safe = sanitizeSegment(name);
  const parsed = path.parse(safe);
  if (parsed.ext.toLowerCase() === desired.toLowerCase()) return safe;
  return `${parsed.name || 'untitled'}${desired}`;
}

function outputNameFor(item, strategy) {
  const name = item.name || item.fname || `file-${item.id || item.fileId || 'unknown'}`;
  return strategy === 'EXPORT_DOCX' ? replaceExtension(name, '.docx') : sanitizeSegment(name);
}

function resolveOutputPath(baseDir, item, strategy) {
  const relativePath = String(item.relativePath || item.path || '');
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length && parts.at(-1) === item.name) parts.pop();
  const directories = parts.map((part) => sanitizeSegment(part));
  return path.resolve(baseDir, ...directories, outputNameFor(item, strategy));
}

module.exports = {
  outputNameFor,
  replaceExtension,
  resolveOutputPath,
  sanitizeSegment,
};

