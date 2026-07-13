#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const DIFF_TYPES = [
  'GOLDEN_SUCCESS_NEW_FAILED',
  'GOLDEN_VALID_NEW_INVALID',
  'AIRPAGE_IDENTITY_MISMATCH',
  'FILE_ID_MAPPING_MISMATCH',
  'EXPORT_CREATE_STAGE_MISMATCH',
  'POLL_STAGE_MISMATCH',
  'OUTPUT_EXTENSION_MISMATCH',
  'OUTPUT_PATH_MISMATCH',
  'DOCX_STRUCTURE_MISMATCH',
  'AUTH_CONTEXT_MISMATCH',
];

function parseArgs(argv) {
  const options = { golden: '', next: '', output: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--golden') options.golden = argv[++index] || '';
    else if (arg === '--new') options.next = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
  }
  if (!options.golden || !options.next || !options.output) throw new Error('--golden, --new and --output are required');
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function docxStructure(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, pass: false, fileSize: 0, zipEntryCount: 0, hasContentTypes: false, hasDocumentXml: false, hasWordDir: false };
  }
  const stat = fs.statSync(filePath);
  try {
    const zip = new AdmZip(filePath);
    const names = zip.getEntries().map((entry) => entry.entryName);
    const documentEntry = zip.getEntry('word/document.xml');
    let documentXmlReadable = false;
    if (documentEntry) {
      const text = documentEntry.getData().toString('utf8');
      documentXmlReadable = text.includes('<w:document') || text.includes('w:body');
    }
    const structure = {
      exists: true,
      pass: stat.size > 0 &&
        names.includes('[Content_Types].xml') &&
        names.includes('word/document.xml') &&
        names.some((name) => name.startsWith('word/')) &&
        documentXmlReadable,
      fileSize: stat.size,
      zipEntryCount: names.length,
      hasContentTypes: names.includes('[Content_Types].xml'),
      hasRels: names.includes('_rels/.rels'),
      hasDocumentXml: names.includes('word/document.xml'),
      hasWordDir: names.some((name) => name.startsWith('word/')),
      documentXmlReadable,
    };
    return structure;
  } catch (error) {
    return { exists: true, pass: false, fileSize: stat.size, zipEntryCount: 0, error: error.message };
  }
}

function timelineStep(result, step) {
  return (result.timeline || []).find((item) => item.step === step) || {};
}

function pushIf(condition, differences, type, payload) {
  if (condition) differences[type].push(payload);
}

function main() {
  const options = parseArgs(process.argv);
  const goldenPayload = readJson(options.golden);
  const newPayload = readJson(options.next);
  const golden = goldenPayload.result || {};
  const next = newPayload.result || {};
  const goldenDocx = docxStructure(golden.output_path);
  const newDocx = docxStructure(next.output_path);
  const differences = Object.fromEntries(DIFF_TYPES.map((type) => [type, []]));

  pushIf(golden.ok && !next.ok, differences, 'GOLDEN_SUCCESS_NEW_FAILED', {
    fileId: golden.file_id,
    newStatus: next.status,
    newErrorStage: next.error_stage || '',
    newErrorCode: next.error_code || '',
  });
  pushIf(Boolean(golden.validation?.pass) && !Boolean(next.validation?.pass), differences, 'GOLDEN_VALID_NEW_INVALID', {
    fileId: golden.file_id,
    newValidation: next.validation || null,
  });
  pushIf((golden.export?.download_url_path || '') !== (next.export?.download_url_path || ''), differences, 'AIRPAGE_IDENTITY_MISMATCH', {
    golden: golden.export?.download_url_path || '',
    new: next.export?.download_url_path || '',
  });
  pushIf(String(golden.file_id || '') !== String(next.file_id || ''), differences, 'FILE_ID_MAPPING_MISMATCH', {
    golden: golden.file_id || '',
    new: next.file_id || '',
  });
  pushIf((timelineStep(golden, 'preload').status || '') !== (timelineStep(next, 'preload').status || ''), differences, 'EXPORT_CREATE_STAGE_MISMATCH', {
    golden: timelineStep(golden, 'preload'),
    new: timelineStep(next, 'preload'),
  });
  pushIf((timelineStep(golden, 'result').api_status || '') !== (timelineStep(next, 'result').api_status || ''), differences, 'POLL_STAGE_MISMATCH', {
    golden: timelineStep(golden, 'result'),
    new: timelineStep(next, 'result'),
  });
  pushIf(path.extname(golden.output_path || '').toLowerCase() !== '.docx' || path.extname(next.output_path || '').toLowerCase() !== '.docx', differences, 'OUTPUT_EXTENSION_MISMATCH', {
    golden: path.extname(golden.output_path || '').toLowerCase(),
    new: path.extname(next.output_path || '').toLowerCase(),
  });
  pushIf((golden.path || '') !== (next.path || ''), differences, 'OUTPUT_PATH_MISMATCH', {
    golden: golden.path || '',
    new: next.path || '',
  });
  pushIf(!goldenDocx.pass || !newDocx.pass, differences, 'DOCX_STRUCTURE_MISMATCH', {
    golden: goldenDocx,
    new: newDocx,
  });
  pushIf(Boolean(golden.auth?.cookie_present) !== Boolean(next.auth?.cookie_present) ||
    Boolean(golden.auth?.csrf_present) !== Boolean(next.auth?.csrf_present) ||
    Boolean(golden.auth?.wps_sid_present) !== Boolean(next.auth?.wps_sid_present), differences, 'AUTH_CONTEXT_MISMATCH', {
    golden: golden.auth || {},
    new: next.auth || {},
  });

  const counts = Object.fromEntries(DIFF_TYPES.map((type) => [type, differences[type].length]));
  const pass = golden.ok === true &&
    next.ok === true &&
    Boolean(golden.validation?.pass) &&
    Boolean(next.validation?.pass) &&
    goldenDocx.pass &&
    newDocx.pass &&
    Object.values(counts).every((count) => count === 0);

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pass,
    gate: 'gate3_single_historical_docx_export_create_403_otl',
    markers: pass ? ['SINGLE_HISTORICAL_403_OTL_GOLDEN_AB_PASS', '第3门 PASS'] : ['GATE_3_FAILED'],
    checks: {
      SOURCE_ID_MATCH: String(golden.file_id || '') === String(next.file_id || ''),
      AIRPAGE_IDENTITY_MATCH: (golden.export?.download_url_path || '') === (next.export?.download_url_path || ''),
      OUTPUT_EXTENSION_MATCH: path.extname(golden.output_path || '').toLowerCase() === '.docx' && path.extname(next.output_path || '').toLowerCase() === '.docx',
      GOLDEN_STATUS: golden.status || '',
      NEW_STATUS: next.status || '',
      GOLDEN_VALIDATION: Boolean(golden.validation?.pass),
      NEW_VALIDATION: Boolean(next.validation?.pass),
      EXPORT_CREATE_BEHAVIOR: {
        golden: timelineStep(golden, 'preload').status || '',
        new: timelineStep(next, 'preload').status || '',
      },
      POLL_FINAL_STATUS: {
        golden: timelineStep(golden, 'result').api_status || '',
        new: timelineStep(next, 'result').api_status || '',
      },
      OUTPUT_PATH: {
        golden: golden.output_path || '',
        new: next.output_path || '',
      },
      FILE_SIZE: {
        golden: goldenDocx.fileSize,
        new: newDocx.fileSize,
      },
      ZIP_STRUCTURE: {
        golden: goldenDocx,
        new: newDocx,
      },
    },
    counts,
    differences,
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: pass, output: path.resolve(options.output), counts, markers: output.markers }, null, 2));
  if (!pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
}
