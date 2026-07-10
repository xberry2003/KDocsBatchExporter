'use strict';

const fs = require('fs');
const path = require('path');

function parseCookie(cookie) {
  const values = {};
  for (const part of String(cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && values[name] == null) values[name] = value;
  }
  return values;
}

class SessionStore {
  constructor(options = {}) {
    if (!options.credentialPath) {
      throw new Error('SessionStore requires credentialPath');
    }
    this.credentialPath = path.resolve(options.credentialPath);
    this.credentials = options.credentials || null;
  }

  load() {
    if (this.credentials) return this.credentials;
    if (!fs.existsSync(this.credentialPath)) {
      const error = new Error(`Credential file not found: ${this.credentialPath}`);
      error.code = 'AUTH_CREDENTIAL_NOT_FOUND';
      throw error;
    }

    let credentials;
    try {
      credentials = JSON.parse(fs.readFileSync(this.credentialPath, 'utf8'));
    } catch (cause) {
      const error = new Error('Credential file is not valid JSON');
      error.code = 'AUTH_CREDENTIAL_INVALID';
      error.cause = cause;
      throw error;
    }

    if (!credentials.cookie) {
      const error = new Error('Credential missing cookie');
      error.code = 'AUTH_COOKIE_MISSING';
      throw error;
    }
    this.credentials = credentials;
    return credentials;
  }

  getCookie() {
    return String(this.load().cookie || '');
  }

  getCsrf({ required = false } = {}) {
    const csrf = String(this.load().csrf || '');
    if (required && !csrf) {
      const error = new Error('Credential missing csrf');
      error.code = 'AUTH_CSRF_MISSING';
      throw error;
    }
    return csrf;
  }

  cookieValues() {
    return parseCookie(this.getCookie());
  }

  summary() {
    const credentials = this.load();
    const cookie = String(credentials.cookie || '');
    const csrf = String(credentials.csrf || '');
    return {
      credential_path: this.credentialPath,
      cookie_present: Boolean(cookie),
      csrf_present: Boolean(csrf),
      csrf_length: csrf.length,
      wps_sid_present: /(?:^|;\s*)wps_sid=/.test(cookie),
    };
  }
}

module.exports = { SessionStore, parseCookie };

