'use strict';

const os = require('os');
const path = require('path');

function numberFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function loadConfig(overrides = {}) {
  const rootDir = path.resolve(__dirname, '..', '..');
  const stateDir = path.resolve(
    overrides.stateDir ||
    process.env.KDOCS_STATE_DIR ||
    path.join(rootDir, 'state')
  );

  return {
    rootDir,
    stateDir,
    outputDir: path.resolve(
      overrides.outputDir ||
      process.env.KDOCS_OUTPUT_DIR ||
      path.join(rootDir, 'output')
    ),
    credentialPath: path.resolve(
      overrides.credentialPath ||
      process.env.KDOCS_CREDENTIAL_PATH ||
      path.join(os.homedir(), '.claude', 'secrets', 'wps365.json')
    ),
    kdocsBaseUrl: overrides.kdocsBaseUrl || process.env.KDOCS_BASE_URL || 'https://drive.kdocs.cn',
    kdocs365BaseUrl: overrides.kdocs365BaseUrl || process.env.KDOCS_365_BASE_URL || 'https://365.kdocs.cn',
    directConcurrency: overrides.directConcurrency || numberFromEnv('KDOCS_DIRECT_CONCURRENCY', 2, { max: 5 }),
    airpageConcurrency: overrides.airpageConcurrency || numberFromEnv('KDOCS_AIRPAGE_CONCURRENCY', 1, { max: 2 }),
    directAttempts: overrides.directAttempts || numberFromEnv('KDOCS_DIRECT_ATTEMPTS', 3, { max: 10 }),
    airpageAttempts: overrides.airpageAttempts || numberFromEnv('KDOCS_AIRPAGE_ATTEMPTS', 2, { max: 10 }),
    directRetryDelays: overrides.directRetryDelays || [0, 2000, 5000],
    downloadUrl403RetryDelay: overrides.downloadUrl403RetryDelay || 3000,
    airpagePollMs: overrides.airpagePollMs || 1500,
    airpageTimeoutMs: overrides.airpageTimeoutMs || 120000,
  };
}

module.exports = { loadConfig, numberFromEnv };

