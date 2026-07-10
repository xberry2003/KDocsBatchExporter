'use strict';

const fs = require('fs');
const path = require('path');

const FILE_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

function recordKey(record = {}) {
  if (record.key) return String(record.key);
  const groupId = record.groupId || record.groupid || '';
  const fileId = record.fileId || record.file_id || record.fileid || record.id || '';
  return groupId && fileId ? `${groupId}:${fileId}` : String(fileId || '');
}

function normalizeLegacyRecord(record = {}) {
  const key = recordKey(record);
  return {
    schemaVersion: Number(record.schemaVersion || record.schema_version || 1),
    recordedAt: record.recordedAt || record.recorded_at || record.finished_at || record.started_at || '',
    key,
    groupId: String(record.groupId || record.groupid || ''),
    fileId: String(record.fileId || record.file_id || record.fileid || record.id || ''),
    name: record.name || record.fname || '',
    relativePath: record.relativePath || record.path || record.local_path || '',
    status: record.status || FILE_STATUS.PENDING,
    strategy: record.strategy || record.download_strategy || '',
    outputPath: record.outputPath || record.output_path || record.local_path || '',
    attempts: Number(record.attempts || 0),
    errorStage: record.errorStage || record.error_stage || '',
    errorCode: record.errorCode || record.error_code || '',
    validationPass: Boolean(record.validationPass || record.docx_valid || record.is_docx),
    sourceRecord: record,
  };
}

class ManifestStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.latest = new Map();
    this.latestSuccess = new Map();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  load() {
    this.latest.clear();
    this.latestSuccess.clear();
    if (!fs.existsSync(this.filePath)) {
      this.loaded = true;
      return this;
    }
    const lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const normalized = normalizeLegacyRecord(JSON.parse(line.replace(/^\uFEFF/, '')));
        if (!normalized.key) continue;
        this.latest.set(normalized.key, normalized);
        if (normalized.status === FILE_STATUS.SUCCESS) {
          this.latestSuccess.set(normalized.key, normalized);
        }
      } catch {
        // Interrupted append-only manifests may have a malformed final line.
      }
    }
    this.loaded = true;
    return this;
  }

  get(key) {
    if (!this.loaded) this.load();
    return this.latest.get(String(key));
  }

  getRecoverableRecords() {
    if (!this.loaded) this.load();
    return [...this.latest.values()].map((record) => (
      record.status === FILE_STATUS.RUNNING
        ? { ...record, status: FILE_STATUS.PENDING, recoveredFrom: FILE_STATUS.RUNNING }
        : record
    ));
  }

  shouldSkipSuccess(key, outputPath, validateFn) {
    if (!this.loaded) this.load();
    const success = this.latestSuccess.get(String(key));
    if (!success) return false;
    const target = outputPath || success.outputPath;
    if (!target || !fs.existsSync(target) || fs.statSync(target).size <= 0) return false;
    if (!validateFn) return true;
    try {
      const result = validateFn(target);
      return typeof result === 'object' ? Boolean(result.pass) : Boolean(result);
    } catch {
      return false;
    }
  }

  append(record) {
    if (!this.loaded) this.load();
    const serialized = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      ...record,
    };
    serialized.key = recordKey(serialized);
    if (!serialized.key) throw new Error('Manifest record requires key or groupId + fileId');

    this.writeQueue = this.writeQueue.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.appendFile(this.filePath, `${JSON.stringify(serialized)}\n`, 'utf8');
      const normalized = normalizeLegacyRecord(serialized);
      this.latest.set(normalized.key, normalized);
      if (normalized.status === FILE_STATUS.SUCCESS) {
        this.latestSuccess.set(normalized.key, normalized);
      }
      return serialized;
    });
    return this.writeQueue;
  }

  async flush() {
    await this.writeQueue;
  }
}

module.exports = {
  FILE_STATUS,
  ManifestStore,
  normalizeLegacyRecord,
  recordKey,
};

