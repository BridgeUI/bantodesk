// PROGRESS 4: the app's localhost MCP server (docs/plan-notify.md "4. 受け口"), in place of hooks (the managed policy
// allowManagedHooksOnly stops every --settings hook; an HTTP MCP server at http://localhost:<port>/mcp is allowed).
// No Electron imports (plain Node tests use it too: tmp/mcp/unit.js). CONTRACT.md "App MCP server".
//
// - Listens on 127.0.0.1 only, port 0 (the OS picks a free one: the listen itself is the check, no port scan).
//   The URL given to claude says localhost (the policy refused 127.0.0.1 in the URL on the Windows PC).
// - Streamable HTTP, the plain JSON half: POST /mcp with one JSON-RPC message (or a batch) -> application/json;
//   a notification -> 202. No SSE stream (GET -> 405), no session id (stateless).
// - Who is calling: each tab's claude gets --mcp-config <dir>/<tabId>.json with the headers
//   X-AT-Tab: <tabId> and Authorization: Bearer HMAC-SHA256(secret, tabId). The secret lives only in this process,
//   so a tab cannot speak for another tab and nothing else on the PC can call in. The file is 0600 and removed on close.
// - A browser cannot call in: any Origin header -> 403, Host must be localhost / 127.0.0.1 with our port (DNS rebinding).
// - Tools: notify (the agent tells the user something: the tab's notice, sound and toast like the terminal's OSC 777).
//   Later: propose (U7), browser actions (7), show_file (5b), issues (8).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAME = require('./names').MCP_NAME; // BN3: bantodesk (tools mcp__bantodesk__*)
const VERSION = '0.1.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const BODY_MAX = 64 * 1024;
const TAB_RE = /^[A-Za-z0-9-]{1,64}$/;
const KINDS = ['done', 'input', 'error'];
const TEXT_MAX = 500;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20; // notify calls per tab per minute (more is refused with a tool error, not dropped silently)

const TOOLS = [
  {
    name: 'notify',
    title: 'ユーザーに知らせる',
    description:
      'BantoDesk のユーザーに短い通知を出す（このタブに未読の印・通知音・デスクトップ通知）。ユーザーが画面を見ていないときに、' +
      '判断が要る（kind: input）、失敗して止まった（kind: error）、区切りまで終わった（kind: done）を知らせる。' +
      '作業の途中経過の報告には使わない。message は 1〜2 文の日本語で、何が起きて何をしてほしいかを書く。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '通知の本文（500 字まで）' },
        kind: { type: 'string', enum: KINDS, description: 'done（終わった、既定）/ input（判断や確認が要る）/ error（失敗した）' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolText(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

// start({ onNotify(tabId, { kind, text }) -> boolean|void, configDir?, log? }) -> Promise<server>
// server: { port, url, tabToken(tabId), configFor(tabId) -> path|null, forget(tabId), close() -> Promise, calls }
// onNotify returning false means "no such tab here" (the call gets a tool error).
function start({ onNotify, configDir = null, log = () => {} } = {}) {
  const secret = crypto.randomBytes(32);
  const tabToken = (tabId) => crypto.createHmac('sha256', secret).update(String(tabId)).digest('hex');
  const rate = new Map(); // tabId -> [times]
  const written = new Set(); // config files this run wrote
  const calls = { requests: 0, refused: 0, notify: 0 };
  let port = 0;

  function authed(req) {
    const tab = req.headers['x-at-tab'];
    if (typeof tab !== 'string' || !TAB_RE.test(tab)) return null;
    const m = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const want = Buffer.from(tabToken(tab), 'hex');
    const got = Buffer.from(m[1], 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want) ? tab : null;
  }
  function hostOk(req) {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `localhost:${port}` || h === `127.0.0.1:${port}`;
  }
  function rateOk(tab) {
    const now = Date.now();
    const list = (rate.get(tab) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_MAX) {
      rate.set(tab, list);
      return false;
    }
    list.push(now);
    rate.set(tab, list);
    return true;
  }

  function callTool(tab, name, args) {
    if (name !== 'notify') return toolText(`知らないツールです: ${String(name).slice(0, 60)}`, true);
    const a = args && typeof args === 'object' ? args : {};
    const text = typeof a.message === 'string' ? a.message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, TEXT_MAX) : '';
    if (!text) return toolText('message（通知の本文）が空です。', true);
    const kind = KINDS.includes(a.kind) ? a.kind : 'done';
    if (!rateOk(tab)) return toolText(`通知が多すぎます（1 分に ${RATE_MAX} 件まで）。まとめて 1 件にしてください。`, true);
    let ok;
    try {
      ok = onNotify ? onNotify(tab, { kind, text }) : false;
    } catch (err) {
      log('notify handler failed', err);
      ok = false;
    }
    if (ok === false) return toolText('このタブがアプリに見つからないため、通知を出せませんでした。', true);
    calls.notify++;
    return toolText('通知しました。');
  }

  // one JSON-RPC message -> response object, or null for a notification / response
  function handle(tab, msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid Request');
    const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    if (!isRequest) return null; // notifications (initialized, cancelled) and client responses: nothing to answer
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, version: VERSION },
          instructions: 'BantoDesk（このターミナル アプリ）の機能。notify でユーザーに知らせる。',
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call':
        return rpcResult(id, callTool(tab, params && params.name, params && params.arguments));
      default:
        return rpcError(id, -32601, `Method not found: ${String(method).slice(0, 60)}`);
    }
  }

  const server = http.createServer((req, res) => {
    calls.requests++;
    const refuse = (code, text) => {
      calls.refused++;
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    if (req.headers.origin !== undefined) return refuse(403, 'forbidden');
    if (!hostOk(req)) return refuse(403, 'forbidden');
    const url = String(req.url || '').split('?')[0];
    if (url !== '/mcp') return refuse(404, 'not found');
    const tab = authed(req);
    if (!tab) return refuse(401, 'unauthorized');
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' });
      return res.end('method not allowed');
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        over = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      }
      const batch = Array.isArray(body);
      const out = (batch ? body : [body]).slice(0, 50).map((m) => handle(tab, m)).filter(Boolean);
      if (!out.length) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch ? out : out[0]));
    });
    req.on('error', () => {});
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  // config files of an earlier run (a crash) carry a dead secret: removed before the first is written
  if (configDir) {
    try {
      for (const f of fs.readdirSync(configDir)) if (/\.json$/.test(f)) fs.rmSync(path.join(configDir, f), { force: true });
    } catch {}
  }

  function configFor(tabId) {
    if (!configDir || !port || typeof tabId !== 'string' || !TAB_RE.test(tabId)) return null;
    const file = path.join(configDir, `${tabId}.json`);
    const conf = {
      mcpServers: {
        [NAME]: {
          type: 'http',
          url: `http://localhost:${port}/mcp`,
          headers: { Authorization: `Bearer ${tabToken(tabId)}`, 'X-AT-Tab': tabId },
        },
      },
    };
    try {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(conf, null, 1), { mode: 0o600 });
      written.add(file);
      return file;
    } catch (err) {
      log('mcp config not written', err);
      return null;
    }
  }
  function forget(tabId) {
    if (!configDir || typeof tabId !== 'string' || !TAB_RE.test(tabId)) return;
    const file = path.join(configDir, `${tabId}.json`);
    written.delete(file);
    rate.delete(tabId);
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
  function close() {
    for (const f of written) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
    written.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', (err) => log('mcp server error', err));
      port = server.address().port;
      resolve({ get port() { return port; }, get url() { return `http://localhost:${port}/mcp`; }, tabToken, configFor, forget, close, calls });
    });
  });
}

module.exports = { start, TOOLS, PROTOCOLS, NAME };
