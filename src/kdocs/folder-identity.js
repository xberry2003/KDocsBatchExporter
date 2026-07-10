'use strict';

function parseKDocsUrl(rawUrl) {
  const url = new URL(rawUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  const kind = segments[0] || '';

  if (kind === 'ent' || kind === 'space') {
    const orgId = segments[1] || '';
    const groupId = segments[2] || '';
    if (!orgId || !groupId) {
      throw new Error(`Invalid KDocs enterprise URL: ${rawUrl}`);
    }
    const folderId = segments[3] || `-${groupId}`;
    return {
      kind,
      hostname: url.hostname,
      orgId,
      groupId,
      parentId: folderId,
      folderId,
      sourceUrl: url.toString(),
    };
  }

  throw new Error(`Unsupported KDocs URL: ${rawUrl}`);
}

module.exports = { parseKDocsUrl };

