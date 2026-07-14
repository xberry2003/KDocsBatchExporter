'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config/config');
const { SessionStore } = require('../auth/session-store');
const { KDocsApiClient } = require('../kdocs/api-client');
const { parseKDocsUrl } = require('../kdocs/folder-identity');
const { KDocsFolderScanner } = require('../kdocs/folder-scanner');
const { ITEM_TYPE, detectFileType, extensionOf } = require('../kdocs/file-type-detector');
const { DOWNLOAD_STRATEGY, resolveStrategy } = require('../download/router');
const { DirectDownloader, validationTypeFor } = require('../download/direct-downloader');
const { RetryPolicy } = require('../download/retry-policy');
const { validateFile } = require('../download/validators');
const { resolveOutputPath } = require('../download/output-path-resolver');
const { AirPageDocxExporter } = require('../airpage/docx-exporter');
const { ManifestStore, FILE_STATUS } = require('../manifest/manifest-store');

function nowIso() {
  return new Date().toISOString();
}

function fileIdOf(item = {}) {
  return String(item.id || item.fileId || item.file_id || '');
}

function groupIdOf(item = {}) {
  return String(item.groupId || item.groupid || '');
}

function taskIdentityOf(identity) {
  return `${identity.groupId}:${identity.parentId}`;
}

function safeTaskDirName(taskIdentity) {
  return taskIdentity.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

function jsonlWrite(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function jsonlRead(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedExtension(item, strategy) {
  if (strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX) return '.docx';
  if (strategy === DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD) return extensionOf(item);
  return '';
}

function skipReasonFor(fileType) {
  if (fileType === ITEM_TYPE.DBT_SPECIAL_DOCUMENT) return 'USER_ACCEPTED_MANUAL_DOWNLOAD_DBT';
  if (fileType === ITEM_TYPE.FORM) return 'FORM_EXPORT_NOT_IMPLEMENTED';
  return 'UNSUPPORTED_OR_UNKNOWN_FILE_TYPE';
}

function normalizeManualExtensions(values = []) {
  return new Set(values.map((value) => {
    const ext = String(value || '').trim().toLowerCase();
    if (!ext) return '';
    return ext.startsWith('.') ? ext : `.${ext}`;
  }).filter(Boolean));
}

function routeItem(item, outputDir, manualExtensions = []) {
  const fileType = detectFileType(item);
  const manualExts = normalizeManualExtensions(manualExtensions);
  const sourceExtension = extensionOf(item);
  const strategy = manualExts.has(sourceExtension) || fileType === ITEM_TYPE.UNKNOWN
    ? DOWNLOAD_STRATEGY.SKIP_MANUAL
    : resolveStrategy(item);
  const outputPath = strategy === DOWNLOAD_STRATEGY.SKIP
    ? ''
    : strategy === DOWNLOAD_STRATEGY.SKIP_MANUAL
      ? ''
    : resolveOutputPath(outputDir, item, strategy);
  const manualExtReason = manualExts.has(sourceExtension) && fileType !== ITEM_TYPE.DBT_SPECIAL_DOCUMENT && fileType !== ITEM_TYPE.FORM
    ? `MANUAL_EXTENSION_${sourceExtension.replace(/^\./, '').toUpperCase()}`
    : '';
  return {
    schemaVersion: 1,
    fileId: fileIdOf(item),
    groupId: groupIdOf(item),
    parentId: String(item.parentId || item.parentid || ''),
    name: item.name || '',
    relativePath: item.relativePath || '',
    fileType,
    rawFileType: item.fileType || '',
    sourceExtension,
    linkUrlPresent: Boolean(item.linkUrl),
    strategy,
    expectedOutputExtension: expectedExtension(item, strategy),
    expectedOutputPath: outputPath,
    skipReason: [DOWNLOAD_STRATEGY.SKIP, DOWNLOAD_STRATEGY.SKIP_MANUAL].includes(strategy) ? (manualExtReason || skipReasonFor(fileType)) : '',
  };
}

function uniquifyOutputPaths(plan) {
  const seen = new Map();
  for (const entry of plan) {
    if (!entry.expectedOutputPath) continue;
    const key = entry.expectedOutputPath.toLowerCase();
    const prior = seen.get(key) || [];
    prior.push(entry);
    seen.set(key, prior);
  }
  for (const duplicates of seen.values()) {
    if (duplicates.length <= 1) continue;
    for (const entry of duplicates) {
      const parsed = path.parse(entry.expectedOutputPath);
      entry.expectedOutputPath = path.join(parsed.dir, `${parsed.name}__${entry.fileId}${parsed.ext}`);
      entry.outputPathDisambiguated = true;
    }
  }
  return plan;
}

function countBy(items, fn) {
  const counts = {};
  for (const item of items) {
    const key = fn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function typeStats(plan) {
  return {
    airpageOtl: plan.filter((item) => item.fileType === ITEM_TYPE.AIRPAGE_ONLINE_DOCUMENT).length,
    pdf: plan.filter((item) => item.fileType === ITEM_TYPE.PDF).length,
    ppt: plan.filter((item) => item.fileType === ITEM_TYPE.PPT).length,
    pptx: plan.filter((item) => item.fileType === ITEM_TYPE.PPTX).length,
    xls: plan.filter((item) => item.fileType === ITEM_TYPE.XLS).length,
    xlsx: plan.filter((item) => item.fileType === ITEM_TYPE.XLSX).length,
    otherFile: plan.filter((item) => item.fileType === ITEM_TYPE.OTHER_FILE).length,
    form: plan.filter((item) => item.fileType === ITEM_TYPE.FORM).length,
    unknown: plan.filter((item) => item.fileType === ITEM_TYPE.UNKNOWN).length,
    exportDocx: plan.filter((item) => item.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX).length,
    directDownload: plan.filter((item) => item.strategy === DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD).length,
    skip: plan.filter((item) => item.strategy === DOWNLOAD_STRATEGY.SKIP).length,
    skipManual: plan.filter((item) => item.strategy === DOWNLOAD_STRATEGY.SKIP_MANUAL).length,
  };
}

function auditRouting(plan) {
  const duplicates = countBy(plan, (entry) => entry.fileId);
  const outputPathCounts = countBy(
    plan.filter((entry) => entry.expectedOutputPath),
    (entry) => entry.expectedOutputPath.toLowerCase()
  );
  return {
    ROUTE_MISMATCH: 0,
    OTL_ROUTED_TO_DIRECT_DOWNLOAD: plan.filter((entry) => entry.fileType === ITEM_TYPE.AIRPAGE_ONLINE_DOCUMENT && entry.strategy !== DOWNLOAD_STRATEGY.EXPORT_DOCX).length,
    DIRECT_FILE_ROUTED_TO_EXPORT_DOCX: plan.filter((entry) => ![ITEM_TYPE.AIRPAGE_ONLINE_DOCUMENT, ITEM_TYPE.DBT_SPECIAL_DOCUMENT, ITEM_TYPE.FORM, ITEM_TYPE.UNKNOWN].includes(entry.fileType) && entry.strategy !== DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD).length,
    UNSUPPORTED_FILE_PROCESSED: plan.filter((entry) => [ITEM_TYPE.DBT_SPECIAL_DOCUMENT, ITEM_TYPE.FORM, ITEM_TYPE.UNKNOWN].includes(entry.fileType) && ![DOWNLOAD_STRATEGY.SKIP, DOWNLOAD_STRATEGY.SKIP_MANUAL].includes(entry.strategy)).length,
    SUPPORTED_FILE_WITHOUT_STRATEGY: plan.filter((entry) => !entry.strategy && ![ITEM_TYPE.FORM, ITEM_TYPE.UNKNOWN].includes(entry.fileType)).length,
    DUPLICATE_OUTPUT_PATH: Object.values(outputPathCounts).filter((count) => count > 1).length,
    DUPLICATE_FILE_ID: Object.values(duplicates).filter((count) => count > 1).length,
    SKIP_WITHOUT_REASON: plan.filter((entry) => [DOWNLOAD_STRATEGY.SKIP, DOWNLOAD_STRATEGY.SKIP_MANUAL].includes(entry.strategy) && !entry.skipReason).length,
  };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

function directRecordFromResult(taskIdentity, planEntry, result) {
  return {
    schemaVersion: 1,
    taskIdentity,
    fileId: planEntry.fileId,
    groupId: planEntry.groupId,
    name: planEntry.name,
    relativePath: planEntry.relativePath,
    fileType: planEntry.fileType,
    strategy: planEntry.strategy,
    status: result.ok ? FILE_STATUS.SUCCESS : FILE_STATUS.FAILED,
    attempts: result.attempts || 0,
    errorStage: result.errorStage || '',
    errorCode: result.errorCode || '',
    skipReason: '',
    outputPath: result.outputPath || planEntry.expectedOutputPath,
    outputExtension: result.outputExtension || path.extname(planEntry.expectedOutputPath).toLowerCase(),
    fileSize: result.fileSize || 0,
    validationResult: result.validation || null,
    startedAt: result.startedAt || '',
    finishedAt: result.finishedAt || nowIso(),
  };
}

async function exportAirPageWithRetry(exporter, item, planEntry, maxAttempts, options = {}) {
  let finalResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    finalResult = await exporter.exportFile({
      ...item,
      file_id: fileIdOf(item),
      groupid: groupIdOf(item),
      path: item.relativePath,
      output_name: path.basename(planEntry.expectedOutputPath),
    }, { outputPath: planEntry.expectedOutputPath });
    finalResult.attempts = attempt;
    if (finalResult.ok && finalResult.validation?.pass) break;
    if (attempt < maxAttempts && options.retryDelayMs) await sleep(options.retryDelayMs);
  }
  return finalResult;
}

function airpageRecordFromResult(taskIdentity, planEntry, result) {
  return {
    schemaVersion: 1,
    taskIdentity,
    fileId: planEntry.fileId,
    groupId: planEntry.groupId,
    name: planEntry.name,
    relativePath: planEntry.relativePath,
    fileType: planEntry.fileType,
    strategy: planEntry.strategy,
    status: result.ok && result.validation?.pass ? FILE_STATUS.SUCCESS : FILE_STATUS.FAILED,
    attempts: result.attempts || 0,
    errorStage: result.error_stage || '',
    errorCode: result.error_code || '',
    errorMessage: result.error_message || '',
    httpStatus: result.http_status || '',
    contentType: result.content_type || '',
    responseShape: result.response_shape || null,
    responseSummary: result.response_summary || null,
    apiStatus: result.api_status || '',
    skipReason: '',
    outputPath: result.output_path || planEntry.expectedOutputPath,
    outputExtension: path.extname(result.output_path || planEntry.expectedOutputPath).toLowerCase(),
    fileSize: result.validation?.size || 0,
    validationResult: result.validation || null,
    exportCreateStatus: (result.timeline || []).find((entry) => entry.step === 'preload')?.status || '',
    pollCount: result.export?.poll_count || '',
    pollFinalStatus: (result.timeline || []).find((entry) => entry.step === 'result')?.api_status || '',
    startedAt: result.started_at || '',
    finishedAt: result.finished_at || nowIso(),
  };
}

function skipRecord(taskIdentity, planEntry) {
  const time = nowIso();
  const manual = planEntry.strategy === DOWNLOAD_STRATEGY.SKIP_MANUAL;
  return {
    schemaVersion: 1,
    taskIdentity,
    fileId: planEntry.fileId,
    groupId: planEntry.groupId,
    name: planEntry.name,
    relativePath: planEntry.relativePath,
    fileType: planEntry.fileType,
    strategy: planEntry.strategy,
    status: manual ? 'manual_required' : FILE_STATUS.SKIPPED,
    attempts: 0,
    errorStage: '',
    errorCode: '',
    skipReason: planEntry.skipReason,
    outputPath: '',
    outputExtension: '',
    fileSize: 0,
    validationResult: null,
    manualDownloadRequired: manual,
    failureCategory: manual ? 'MANUAL_DOWNLOAD_REQUIRED' : 'UNSUPPORTED_OR_UNKNOWN_FILE_TYPE',
    reason: planEntry.skipReason,
    startedAt: time,
    finishedAt: time,
  };
}

function auditResults(plan, finalRecords) {
  const byFileId = new Map(finalRecords.map((record) => [record.fileId, record]));
  const missing = plan.filter((entry) => !byFileId.has(entry.fileId));
  const automaticallySupported = finalRecords.filter((record) => ![DOWNLOAD_STRATEGY.SKIP, DOWNLOAD_STRATEGY.SKIP_MANUAL].includes(record.strategy));
  const outputPathCounts = countBy(
    automaticallySupported.filter((record) => record.outputPath),
    (record) => record.outputPath.toLowerCase()
  );
  return {
    MANIFEST_MISSING_ITEM: missing.length,
    PENDING_OR_RUNNING_FINAL_STATE: finalRecords.filter((record) => [FILE_STATUS.PENDING, FILE_STATUS.RUNNING].includes(record.status)).length,
    SUPPORTED_FAILED_COUNT: automaticallySupported.filter((record) => record.status !== FILE_STATUS.SUCCESS).length,
    OTL_OUTPUT_AS_OTL: finalRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX && record.outputExtension !== '.docx').length,
    OTL_DOT_DOCX_DUPLICATION: finalRecords.filter((record) => /\.otl\.docx$/i.test(record.outputPath || '') || /\.docx\.docx$/i.test(record.outputPath || '')).length,
    DOCX_VALIDATION_FAILURE: finalRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX && !record.validationResult?.pass).length,
    DIRECT_OUTPUT_EXTENSION_MISMATCH: finalRecords.filter((record) => {
      if (record.strategy !== DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD) return false;
      const expected = path.extname(record.name || '').toLowerCase();
      return expected && record.outputExtension !== expected;
    }).length,
    DIRECT_VALIDATION_FAILURE: finalRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD && !record.validationResult?.pass).length,
    SKIP_WITHOUT_REASON: finalRecords.filter((record) => [DOWNLOAD_STRATEGY.SKIP, DOWNLOAD_STRATEGY.SKIP_MANUAL].includes(record.strategy) && !record.skipReason).length,
    DUPLICATE_OUTPUT_PATH: Object.values(outputPathCounts).filter((count) => count > 1).length,
  };
}

async function resolveDirectChildFolder(apiClient, identity, childName) {
  if (!childName) return identity;
  const children = await apiClient.listFolderFiles(identity.groupId, identity.parentId, { sourceUrl: identity.sourceUrl });
  const matches = children.filter((item) => item.isFolder && item.name === childName);
  if (matches.length !== 1) {
    const error = new Error(`Expected exactly one direct child folder named ${childName}, got ${matches.length}`);
    error.code = 'TARGET_FOLDER_MATCH_COUNT_INVALID';
    error.matches = matches.map((item) => ({
      folderId: item.id,
      groupId: item.groupId,
      relativePath: item.name,
      url: `https://365.kdocs.cn/ent/${identity.orgId}/${identity.groupId}/${item.id}`,
    }));
    throw error;
  }
  const folder = matches[0];
  return {
    ...identity,
    parentId: folder.id,
    folderId: folder.id,
    sourceUrl: `https://365.kdocs.cn/ent/${identity.orgId}/${identity.groupId}/${folder.id}`,
    resolvedFolderName: folder.name,
  };
}

function failureListRecord(record, planEntry) {
  return {
    taskIdentity: record.taskIdentity,
    fileId: record.fileId,
    groupId: record.groupId,
    parentId: planEntry?.parentId || '',
    name: record.name,
    relativePath: record.relativePath,
    fileType: record.fileType,
    sourceExtension: planEntry?.sourceExtension || '',
    strategy: record.strategy,
    status: record.status,
    failureCategory: record.failureCategory || 'AUTO_PROCESSING_FAILED',
    attempts: record.attempts || 0,
    errorStage: record.errorStage || null,
    httpStatus: record.httpStatus || null,
    reason: record.reason || record.errorCode || record.skipReason || '',
    sourceUrl: '',
    linkUrl: '',
    manualDownloadRequired: Boolean(record.manualDownloadRequired),
  };
}

function latestManifestRecords(manifest) {
  return manifest.getRecoverableRecords().map((record) => record.sourceRecord || record);
}

function finalRecordsFromManifest(plan, manifest) {
  const latestByKey = new Map();
  for (const record of latestManifestRecords(manifest)) {
    const key = `${record.groupId || record.groupid || ''}:${record.fileId || record.file_id || record.fileid || record.id || ''}`;
    if (key !== ':') latestByKey.set(key, record);
  }
  return plan
    .map((entry) => latestByKey.get(`${entry.groupId}:${entry.fileId}`))
    .filter(Boolean)
    .sort((a, b) => plan.findIndex((entry) => entry.fileId === a.fileId) - plan.findIndex((entry) => entry.fileId === b.fileId));
}

function existingValidSuccess(manifest, entry, validateFn) {
  const key = `${entry.groupId}:${entry.fileId}`;
  const existing = manifest.get(key);
  if (!existing || existing.status !== FILE_STATUS.SUCCESS) return null;
  if (!manifest.shouldSkipSuccess(key, entry.expectedOutputPath, validateFn)) return null;
  return existing.sourceRecord || existing;
}

function writeFinalTaskState({ task, plan, manifest, paths, routingAudit, stats, startedAt, retriedCount = 0 }) {
  const finalRecords = finalRecordsFromManifest(plan, manifest);
  const resultAudit = auditResults(plan, finalRecords);
  const finishedAt = nowIso();
  const successRecords = finalRecords.filter((record) => record.status === FILE_STATUS.SUCCESS);
  const failedRecords = finalRecords.filter((record) => record.status === FILE_STATUS.FAILED);
  const skippedRecords = finalRecords.filter((record) => record.status === FILE_STATUS.SKIPPED);
  const manualRequiredRecords = finalRecords.filter((record) => record.status === 'manual_required');
  const result = {
    schemaVersion: 1,
    taskIdentity: task.taskIdentity,
    groupId: String(task.groupId),
    folderId: String(task.folderId),
    directoryUrl: task.directoryUrl,
    directoryName: task.directoryName,
    startedAt: task.startedAt || startedAt,
    finishedAt,
    totalDurationMs: task.startedAt ? Date.parse(finishedAt) - Date.parse(task.startedAt) : 0,
    lastRetryStartedAt: startedAt,
    lastRetryRetriedCount: retriedCount,
    totalFileCount: plan.length,
    scannedFileCount: plan.length,
    successCount: successRecords.length,
    failedCount: failedRecords.length,
    skippedCount: skippedRecords.length,
    autoFailedCount: failedRecords.filter((record) => !record.manualDownloadRequired).length,
    manualDownloadRequiredCount: manualRequiredRecords.length,
    unsupportedSkipCount: finalRecords.filter((record) => record.status === FILE_STATUS.SKIPPED).length,
    dbtManualRequiredCount: finalRecords.filter((record) => record.fileType === ITEM_TYPE.DBT_SPECIAL_DOCUMENT && record.status === 'manual_required').length,
    formManualRequiredCount: finalRecords.filter((record) => record.fileType === ITEM_TYPE.FORM && record.status === 'manual_required').length,
    unknownManualRequiredCount: finalRecords.filter((record) => record.fileType === ITEM_TYPE.UNKNOWN && record.status === 'manual_required').length,
    notAutomaticallyCompletedCount: finalRecords.filter((record) => record.status !== FILE_STATUS.SUCCESS).length,
    exportDocxSuccessCount: successRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX).length,
    directDownloadSuccessCount: successRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD).length,
    exportDocxCount: stats.exportDocx,
    directDownloadCount: stats.directDownload,
    skipCount: stats.skip,
    skipManualCount: stats.skipManual,
    supportedFailedCount: resultAudit.SUPPORTED_FAILED_COUNT,
    typeStats: stats,
    strategyStats: countBy(plan, (entry) => entry.strategy),
    routeAudit: routingAudit,
    resultAudit,
    paths,
  };
  fs.writeFileSync(paths.result, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const planById = new Map(plan.map((entry) => [entry.fileId, entry]));
  const failedList = finalRecords
    .filter((record) => record.status !== FILE_STATUS.SUCCESS)
    .map((record) => failureListRecord(record, planById.get(record.fileId)));
  const manualList = failedList.filter((record) => record.manualDownloadRequired);
  jsonlWrite(paths.failedFiles, failedList);
  jsonlWrite(paths.manualDownloadRequired, manualList);
  fs.writeFileSync(paths.audit, `${JSON.stringify({
    schemaVersion: 1,
    taskIdentity: task.taskIdentity,
    routingAudit,
    resultAudit,
    countClosure: {
      scannedFileCountEqualsStrategies: result.scannedFileCount === result.exportDocxCount + result.directDownloadCount + result.skipCount + result.skipManualCount,
      totalFileCountEqualsFinalStates: result.totalFileCount === result.successCount + result.failedCount + result.skippedCount + result.manualDownloadRequiredCount,
      totalFileCountEqualsDetailedStates: result.totalFileCount === result.successCount + result.autoFailedCount + result.manualDownloadRequiredCount + result.unsupportedSkipCount,
      successCountEqualsStrategySuccess: result.successCount === result.exportDocxSuccessCount + result.directDownloadSuccessCount,
    },
  }, null, 2)}\n`, 'utf8');
  return result;
}

async function runRetryFailed(options = {}) {
  const config = loadConfig(options);
  if (!options.taskDir && !options.stateDir) throw new Error('--task-dir is required');
  const taskDir = path.resolve(options.taskDir || options.stateDir);
  const paths = {
    task: path.join(taskDir, 'task.json'),
    scan: path.join(taskDir, 'scan.jsonl'),
    routingPlan: path.join(taskDir, 'routing-plan.jsonl'),
    manifest: path.join(taskDir, 'manifest.jsonl'),
    result: path.join(taskDir, 'result.json'),
    audit: path.join(taskDir, 'audit.json'),
    failedFiles: path.join(taskDir, 'failed-files.jsonl'),
    manualDownloadRequired: path.join(taskDir, 'manual-download-required.jsonl'),
    logs: path.join(taskDir, 'logs'),
  };
  const task = JSON.parse(fs.readFileSync(paths.task, 'utf8'));
  const plan = jsonlRead(paths.routingPlan);
  const scanFiles = jsonlRead(paths.scan).filter((record) => record.recordType === 'file');
  const failedFiles = jsonlRead(paths.failedFiles);
  const manifest = new ManifestStore(paths.manifest).load();
  const routingAudit = auditRouting(plan);
  const stats = typeStats(plan);
  const scanById = new Map(scanFiles.map((record) => [String(record.fileId), record]));
  const planById = new Map(plan.map((entry) => [String(entry.fileId), entry]));
  const failedIds = new Set(failedFiles
    .filter((record) => !record.manualDownloadRequired)
    .filter((record) => !options.strategy || record.strategy === options.strategy)
    .map((record) => String(record.fileId)));
  const candidates = [...failedIds]
    .map((fileId) => planById.get(fileId))
    .filter((entry) => entry && entry.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX)
    .filter((entry) => {
      const existing = manifest.get(`${entry.groupId}:${entry.fileId}`);
      if (!existing || existing.status !== FILE_STATUS.SUCCESS) return true;
      return !manifest.shouldSkipSuccess(`${entry.groupId}:${entry.fileId}`, entry.expectedOutputPath, (filePath) => validateFile(filePath, 'docx'));
    });

  const startedAt = nowIso();
  const airpageExporter = new AirPageDocxExporter({
    credentialPath: config.credentialPath,
    timeoutMs: config.airpageTimeoutMs,
    pollMs: config.airpagePollMs,
  });
  const retryDelayMs = Number(options.airpageRetryDelayMs || 5000);
  const airpageRecords = await runPool(candidates, Number(options.airpageConcurrency || 1), async (entry) => {
    const scan = scanById.get(entry.fileId) || {};
    const item = {
      id: entry.fileId,
      groupId: entry.groupId,
      parentId: entry.parentId,
      name: entry.name,
      relativePath: entry.relativePath,
      fileType: scan.fileType || entry.rawFileType || entry.fileType,
      linkUrl: scan.linkUrl || '',
    };
    const result = await exportAirPageWithRetry(
      airpageExporter,
      item,
      entry,
      Number(options.airpageAttempts || config.airpageAttempts),
      { retryDelayMs }
    );
    return airpageRecordFromResult(task.taskIdentity, entry, result);
  });
  for (const record of airpageRecords) await manifest.append(record);
  await manifest.flush();

  const result = writeFinalTaskState({
    task,
    plan,
    manifest,
    paths,
    routingAudit,
    stats,
    startedAt,
    retriedCount: candidates.length,
  });
  return {
    ...result,
    retryFailed: true,
    retriedCount: candidates.length,
    retrySuccessCount: airpageRecords.filter((record) => record.status === FILE_STATUS.SUCCESS).length,
    retryFailedCount: airpageRecords.filter((record) => record.status !== FILE_STATUS.SUCCESS).length,
  };
}

async function runUnifiedExport(options = {}) {
  const config = loadConfig(options);
  const initialIdentity = parseKDocsUrl(options.url);
  const preSessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const preApiClient = new KDocsApiClient({ sessionStore: preSessionStore, baseUrl: config.kdocsBaseUrl });
  const identity = await resolveDirectChildFolder(preApiClient, initialIdentity, options.findChildName || '');
  const taskIdentity = taskIdentityOf(identity);
  const taskDir = path.resolve(
    options.taskDir ||
    (options.stateRoot ? path.join(options.stateRoot, safeTaskDirName(taskIdentity)) : '') ||
    path.join(config.stateDir, 'tasks', safeTaskDirName(taskIdentity))
  );
  const outputDir = path.resolve(options.output || path.join(taskDir, 'output'));
  const paths = {
    task: path.join(taskDir, 'task.json'),
    scan: path.join(taskDir, 'scan.jsonl'),
    routingPlan: path.join(taskDir, 'routing-plan.jsonl'),
    manifest: path.join(taskDir, 'manifest.jsonl'),
    result: path.join(taskDir, 'result.json'),
    audit: path.join(taskDir, 'audit.json'),
    failedFiles: path.join(taskDir, 'failed-files.jsonl'),
    manualDownloadRequired: path.join(taskDir, 'manual-download-required.jsonl'),
    logs: path.join(taskDir, 'logs'),
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });

  const startedAt = nowIso();
  const sessionStore = new SessionStore({ credentialPath: config.credentialPath });
  const apiClient = new KDocsApiClient({ sessionStore, baseUrl: config.kdocsBaseUrl });
  const scanner = new KDocsFolderScanner({ apiClient });
  const scanResult = await scanner.scan(identity, {
    traversal: options.traversal || 'stack',
    maxFolders: options.maxFolders || Number.MAX_SAFE_INTEGER,
    rootName: options.name || identity.parentId,
  });

  const task = {
    schemaVersion: 1,
    taskIdentity,
    groupId: String(identity.groupId),
    folderId: String(identity.parentId),
    directoryUrl: identity.sourceUrl,
    directoryName: options.name || identity.resolvedFolderName || scanResult.root.name || String(identity.parentId),
    startedAt,
    outputDir,
    paths,
  };
  fs.writeFileSync(paths.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

  const scanRecords = [
    {
      schemaVersion: 1,
      recordType: 'scan_summary',
      taskIdentity,
      identity,
      stats: scanResult.stats,
    },
    ...scanResult.folders.map((folder) => ({
      schemaVersion: 1,
      recordType: 'folder',
      taskIdentity,
      fileId: folder.id,
      groupId: folder.groupId,
      parentId: folder.parentId,
      name: folder.name,
      relativePath: folder.relativePath,
      fileType: folder.fileType,
      linkUrlPresent: Boolean(folder.linkUrl),
    })),
    ...scanResult.files.map((file) => ({
      schemaVersion: 1,
      recordType: 'file',
      taskIdentity,
      fileId: file.id,
      groupId: file.groupId,
      parentId: file.parentId,
      name: file.name,
      relativePath: file.relativePath,
      fileType: file.fileType,
      size: file.size,
      linkUrlPresent: Boolean(file.linkUrl),
    })),
  ];
  jsonlWrite(paths.scan, scanRecords);

  const plan = uniquifyOutputPaths(scanResult.files.map((file) => routeItem(file, outputDir, options.manualExt || [])));
  jsonlWrite(paths.routingPlan, plan);

  const routingAudit = auditRouting(plan);
  const stats = typeStats(plan);
  if (options.scanOnly) {
    const scanOnlyResult = {
      schemaVersion: 1,
      taskIdentity,
      groupId: String(identity.groupId),
      folderId: String(identity.parentId),
      directoryUrl: identity.sourceUrl,
      directoryName: task.directoryName,
      startedAt,
      finishedAt: nowIso(),
      scanOnly: true,
      folderCount: scanResult.stats.folderCount,
      scannedFileCount: scanResult.stats.fileCount,
      totalFileCount: plan.length,
      exportDocxCount: stats.exportDocx,
      directDownloadCount: stats.directDownload,
      manualDownloadRequiredCount: stats.skipManual,
      unsupportedSkipCount: stats.skip,
      typeStats: stats,
      routeAudit: routingAudit,
      paths,
    };
    fs.writeFileSync(paths.result, `${JSON.stringify(scanOnlyResult, null, 2)}\n`, 'utf8');
    fs.writeFileSync(paths.audit, `${JSON.stringify({
      schemaVersion: 1,
      taskIdentity,
      routingAudit,
      countClosure: {
        scannedFileCountEqualsStrategies: scanOnlyResult.scannedFileCount === scanOnlyResult.exportDocxCount + scanOnlyResult.directDownloadCount + scanOnlyResult.manualDownloadRequiredCount + scanOnlyResult.unsupportedSkipCount,
      },
    }, null, 2)}\n`, 'utf8');
    jsonlWrite(paths.failedFiles, []);
    jsonlWrite(paths.manualDownloadRequired, []);
    return scanOnlyResult;
  }
  const directDownloader = new DirectDownloader({
    apiClient,
    retryPolicy: new RetryPolicy({
      delays: config.directRetryDelays,
      downloadUrl403Delay: config.downloadUrl403RetryDelay,
    }),
    maxAttempts: Number(options.directAttempts || config.directAttempts),
  });
  const airpageExporter = new AirPageDocxExporter({
    credentialPath: config.credentialPath,
    timeoutMs: config.airpageTimeoutMs,
    pollMs: config.airpagePollMs,
  });
  const manifest = new ManifestStore(paths.manifest).load();

  const itemById = new Map(scanResult.files.map((file) => [file.id, file]));
  const directPlan = plan.filter((entry) => entry.strategy === DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD);
  const airpagePlan = plan.filter((entry) => entry.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX);
  const skipRecords = plan
    .filter((entry) => [DOWNLOAD_STRATEGY.SKIP, DOWNLOAD_STRATEGY.SKIP_MANUAL].includes(entry.strategy))
    .map((entry) => skipRecord(taskIdentity, entry));

  for (const record of skipRecords) {
    await manifest.append(record);
  }

  await runPool(directPlan, Number(options.directConcurrency || config.directConcurrency), async (entry) => {
    const item = itemById.get(entry.fileId);
    const validationType = validationTypeFor(item);
    const existing = existingValidSuccess(manifest, entry, (filePath) => validateFile(filePath, validationType));
    if (existing) return existing;
    const result = await directDownloader.download(item, entry.expectedOutputPath, {
      maxAttempts: Number(options.directAttempts || config.directAttempts),
      validationType,
    });
    const record = directRecordFromResult(taskIdentity, entry, result);
    await manifest.append(record);
    return record;
  });

  await runPool(airpagePlan, Number(options.airpageConcurrency || config.airpageConcurrency), async (entry) => {
    const item = itemById.get(entry.fileId);
    const existing = existingValidSuccess(manifest, entry, (filePath) => validateFile(filePath, 'docx'));
    if (existing) return existing;
    const result = await exportAirPageWithRetry(
      airpageExporter,
      item,
      entry,
      Number(options.airpageAttempts || config.airpageAttempts)
    );
    const record = airpageRecordFromResult(taskIdentity, entry, result);
    await manifest.append(record);
    return record;
  });
  await manifest.flush();

  const finalRecords = finalRecordsFromManifest(plan, manifest);
  const resultAudit = auditResults(plan, finalRecords);
  const finishedAt = nowIso();
  const successRecords = finalRecords.filter((record) => record.status === FILE_STATUS.SUCCESS);
  const failedRecords = finalRecords.filter((record) => record.status === FILE_STATUS.FAILED);
  const skippedRecords = finalRecords.filter((record) => record.status === FILE_STATUS.SKIPPED);
  const manualRequiredRecords = finalRecords.filter((record) => record.status === 'manual_required');
  const result = {
    schemaVersion: 1,
    taskIdentity,
    groupId: String(identity.groupId),
    folderId: String(identity.parentId),
    directoryUrl: identity.sourceUrl,
    directoryName: task.directoryName,
    startedAt,
    finishedAt,
    totalDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    totalFileCount: plan.length,
    scannedFileCount: scanResult.stats.fileCount,
    successCount: successRecords.length,
    failedCount: failedRecords.length,
    skippedCount: skippedRecords.length,
    autoFailedCount: failedRecords.filter((record) => !record.manualDownloadRequired).length,
    manualDownloadRequiredCount: manualRequiredRecords.length,
    unsupportedSkipCount: finalRecords.filter((record) => record.status === FILE_STATUS.SKIPPED).length,
    dbtManualRequiredCount: finalRecords.filter((record) => record.fileType === ITEM_TYPE.DBT_SPECIAL_DOCUMENT && record.status === 'manual_required').length,
    formManualRequiredCount: finalRecords.filter((record) => record.fileType === ITEM_TYPE.FORM && record.status === 'manual_required').length,
    unknownManualRequiredCount: finalRecords.filter((record) => record.fileType === ITEM_TYPE.UNKNOWN && record.status === 'manual_required').length,
    notAutomaticallyCompletedCount: finalRecords.filter((record) => record.status !== FILE_STATUS.SUCCESS).length,
    exportDocxSuccessCount: successRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.EXPORT_DOCX).length,
    directDownloadSuccessCount: successRecords.filter((record) => record.strategy === DOWNLOAD_STRATEGY.DIRECT_DOWNLOAD).length,
    exportDocxCount: stats.exportDocx,
    directDownloadCount: stats.directDownload,
    skipCount: stats.skip,
    skipManualCount: stats.skipManual,
    supportedFailedCount: resultAudit.SUPPORTED_FAILED_COUNT,
    typeStats: stats,
    strategyStats: countBy(plan, (entry) => entry.strategy),
    routeAudit: routingAudit,
    resultAudit,
    paths,
  };
  fs.writeFileSync(paths.result, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const planById = new Map(plan.map((entry) => [entry.fileId, entry]));
  const failedList = finalRecords
    .filter((record) => record.status !== FILE_STATUS.SUCCESS)
    .map((record) => failureListRecord(record, planById.get(record.fileId)));
  const manualList = failedList.filter((record) => record.manualDownloadRequired);
  jsonlWrite(paths.failedFiles, failedList);
  jsonlWrite(paths.manualDownloadRequired, manualList);
  fs.writeFileSync(paths.audit, `${JSON.stringify({
    schemaVersion: 1,
    taskIdentity,
    routingAudit,
    resultAudit,
    countClosure: {
      scannedFileCountEqualsStrategies: result.scannedFileCount === result.exportDocxCount + result.directDownloadCount + result.skipCount + result.skipManualCount,
      totalFileCountEqualsFinalStates: result.totalFileCount === result.successCount + result.failedCount + result.skippedCount + result.manualDownloadRequiredCount,
      totalFileCountEqualsDetailedStates: result.totalFileCount === result.successCount + result.autoFailedCount + result.manualDownloadRequiredCount + result.unsupportedSkipCount,
      successCountEqualsStrategySuccess: result.successCount === result.exportDocxSuccessCount + result.directDownloadSuccessCount,
    },
  }, null, 2)}\n`, 'utf8');

  return result;
}

module.exports = {
  runUnifiedExport,
  runRetryFailed,
  auditResults,
  auditRouting,
  routeItem,
  taskIdentityOf,
};
