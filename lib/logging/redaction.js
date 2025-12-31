'use strict';

const SENSITIVE_KEY_RE = /(key|secret|token|password|private)/i;

function buildKnownSecrets() {
  const envKeys = [
    'SOLANATRACKER_API_KEY',
    'SWAP_API_KEY',
    'OPENAI_API_KEY',
    'HELIUS_API_KEY',
    'NEXTBLOCK_API_KEY',
    'xAI_API_KEY',
    'WF_SWAP_PK'
  ];

  const values = [];
  for (const k of envKeys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim().length >= 8) {
      values.push(v.trim());
    }
  }
  return values;
}

/**
 * Redact known secret values and obvious credential patterns from text.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecretsInText(text) {
  if (typeof text !== 'string' || !text) return text;

  let out = text;

  // Redact common query-string credentials.
  out = out.replace(
    /([?&](?:api_key|apikey|apiKey|key)=)([^&\s]+)/gi,
    '$1[REDACTED]'
  );

  // Redact Bearer tokens.
  out = out.replace(/(\bBearer\s+)([A-Za-z0-9._\-~=+/]+)\b/g, '$1[REDACTED]');

  // Redact obvious key/value pairs in text or JSON-ish logs.
  out = out.replace(
    /("?(?:[A-Za-z0-9_.-]*?(?:key|secret|password|private)[A-Za-z0-9_.-]*?)"?\s*[:=]\s*)(\"[^\"]*\"|[^,\s\]\}]+)/gi,
    '$1[REDACTED]'
  );

  // Redact well-known env secrets when they appear verbatim.
  for (const secret of buildKnownSecrets()) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }

  return out;
}

/**
 * Recursively redact sensitive fields from structured data.
 *
 * @param {any} value
 * @returns {any}
 */
function redactSensitiveData(value) {
  const seen = new WeakSet();

  function walk(node) {
    if (node == null) return node;
    if (typeof node === 'string') return redactSecretsInText(node);
    if (typeof node !== 'object') return node;

    if (node instanceof Error) {
      return {
        name: node.name,
        message: redactSecretsInText(node.message || ''),
        stack: redactSecretsInText(node.stack || ''),
      };
    }

    if (seen.has(node)) return '[circular]';
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((entry) => walk(entry));
    }

    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof k === 'string' && SENSITIVE_KEY_RE.test(k)) {
        out[k] = v ? '[redacted]' : v;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }

  return walk(value);
}

module.exports = {
  redactSecretsInText,
  redactSensitiveData,
};
