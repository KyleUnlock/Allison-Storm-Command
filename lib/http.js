'use strict';

/**
 * lib/http.js — minimal request/response helpers shared by api/* handlers.
 * Framework-free: works with Node's raw http req/res and Vercel's req/res.
 */

async function readJson(req) {
  // Vercel may have already parsed req.body.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
    // req.destroy() (the 1MB guard) emits 'close' but neither 'end' nor 'error';
    // without this the awaited Promise would hang until the platform timeout.
    // Registered last so a normal 'end' still wins on the happy path.
    req.on('close', () => resolve({}));
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(payload);
}

// WHATWG URL from a raw request (never url.parse()).
function urlOf(req) {
  const host = (req.headers && req.headers.host) || 'localhost';
  return new URL(req.url, `http://${host}`);
}

module.exports = { readJson, sendJson, urlOf };
