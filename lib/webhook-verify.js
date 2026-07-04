'use strict';

/**
 * lib/webhook-verify.js — shared raw-body HMAC verification for the paid-play
 * ad webhooks (api/meta-webhook.js, api/callrail-webhook.js).
 *
 * Signature verification MUST run over the EXACT raw request bytes — never a
 * re-serialized parsed object — so both handlers capture the raw body via
 * readRawBody() before touching lib/http.readJson. The compare is constant-time
 * (node:crypto timingSafeEqual). Every helper FAILS CLOSED: a missing secret or
 * a missing/empty signature yields `false`, never a thrown 500.
 */

const crypto = require('node:crypto');

/**
 * Constant-time string compare. Returns false (not throw) on length mismatch or
 * null/undefined input, so callers can treat it as a pure boolean gate.
 */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Read the RAW request body as a Buffer. Prefers a platform-provided raw body
 * (req.rawBody / a string|Buffer req.body); otherwise drains the stream. A
 * pre-parsed object body cannot be reconstructed byte-for-byte, so it is
 * re-serialized only as a best-effort last resort (a live deploy configures the
 * function for raw bodies — see note in the handlers). 1MB guard, fail-safe:
 * on error it resolves with whatever was buffered rather than throwing.
 */
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') {
    // Cannot recover exact bytes from a parsed object; best-effort only.
    return Buffer.from(JSON.stringify(req.body));
  }
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/** HMAC-SHA256 of `raw` under `secret`, in the requested digest encoding. */
function hmacSha256(raw, secret, encoding = 'hex') {
  return crypto.createHmac('sha256', secret).update(raw).digest(encoding);
}

/**
 * Verify an HMAC-SHA256 signature over the raw body. FAILS CLOSED: returns false
 * if `secret` is unset/empty or `signature` is missing/empty. `prefix` strips a
 * scheme label such as Meta's "sha256=". `encoding` is the expected digest
 * encoding of the supplied signature ('hex' for Meta, 'base64' for CallRail).
 */
function verifySignature(raw, { secret, signature, encoding = 'hex', prefix = '' } = {}) {
  if (!secret) return false;
  if (signature == null || signature === '') return false;
  let sig = String(signature).trim();
  if (prefix && sig.startsWith(prefix)) sig = sig.slice(prefix.length);
  if (!sig) return false;
  const expected = hmacSha256(raw, secret, encoding);
  return timingSafeEqual(expected, sig);
}

module.exports = { timingSafeEqual, readRawBody, hmacSha256, verifySignature };
