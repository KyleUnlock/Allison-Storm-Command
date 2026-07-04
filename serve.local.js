'use strict';

/**
 * serve.local.js — zero-dependency local dev server (port 4010).
 * Routes every api/* handler and serves the static HTML pages, mirroring the
 * Vercel rewrites (/rep -> rep.html, etc.). Run: `node serve.local.js`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4010;
const ROOT = __dirname;

// api route -> handler module
const routes = {
  '/api/leads': require('./api/leads'),
  '/api/rep-login': require('./api/rep-login'),
  '/api/my-leads': require('./api/my-leads'),
  '/api/board': require('./api/board'),
  '/api/report': require('./api/report'),
  '/api/lead': require('./api/lead'),
  '/api/export': require('./api/export'),
  '/api/sms-optout': require('./api/sms-optout'),
  '/api/storm-status': require('./api/storm-status'),
  '/api/storm-import': require('./api/storm-import'),
  '/api/tasks': require('./api/tasks'),
  '/api/meta-webhook': require('./api/meta-webhook'),
  '/api/callrail-webhook': require('./api/callrail-webhook'),
  '/api/outreach-attempt': require('./api/outreach-attempt'),
  '/api/invoice': require('./api/invoice'),
  '/api/health': require('./api/health'),
};

// pretty path -> html file (Vercel rewrites)
const pages = {
  '/': 'index.html',
  '/rep': 'rep.html',
  '/board': 'board.html',
  '/report': 'report.html',
  '/crm': 'crm.html',
  '/lead': 'lead.html',
  '/login': 'login.html',
  '/notice': 'notice.html',
  '/invoice': 'invoice.html',
};

const CT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function serveFile(res, file) {
  const abs = path.join(ROOT, file);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': CT[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  const handler = routes[pathname];
  if (handler) {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pages[pathname]) return serveFile(res, pages[pathname]);

  // allow direct .html / static asset access
  if (/\.(html|css|js|json)$/.test(pathname)) return serveFile(res, pathname.slice(1));

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Allison Storm Command dev server on http://localhost:${PORT}`));
}

module.exports = server;
