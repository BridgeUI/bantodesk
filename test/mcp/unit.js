// PROGRESS 4: unit test of the app's localhost MCP server (src/main/mcp-server.js) and its --mcp-config argument
// (src/main/claude-cmd.js). Plain Node, no Electron, no claude.   node tmp/mcp/unit.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const APP = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..'); // AT_APP_ROOT = the app to test
const mcp = require(path.join(APP, 'src', 'main', 'mcp-server'));
const claudeCmd = require(path.join(APP, 'src', 'main', 'claude-cmd'));

const TAB = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('ok   ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err));
  }
}

// raw request: { status, headers, body (parsed JSON when it is JSON) }
function req(port, { method = 'POST', pathName = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    if (data !== null) r.write(data);
    r.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-mcp-unit-'));
  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, '{}'); // a config of an earlier run: removed at start
  const got = [];
  const srv = await mcp.start({ configDir: dir, onNotify: (tab, o) => (tab === TAB ? (got.push({ tab, ...o }), true) : false) });
  const port = srv.port;
  const auth = (tab = TAB) => ({ Host: `localhost:${port}`, Authorization: `Bearer ${srv.tabToken(tab)}`, 'X-AT-Tab': tab });
  const call = (body, tab) => req(port, { headers: auth(tab), body });

  await t('1 listens on 127.0.0.1 with an OS-picked port; url says localhost', async () => {
    assert.ok(port > 0);
    assert.strictEqual(srv.url, `http://localhost:${port}/mcp`);
  });
  await t('2 stale config of an earlier run removed', async () => assert.ok(!fs.existsSync(stale)));

  await t('3 configFor writes a 0600 file with url, bearer and tab header', async () => {
    const f = srv.configFor(TAB);
    assert.strictEqual(f, path.join(dir, `${TAB}.json`));
    const c = JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers['bantodesk'];
    assert.deepStrictEqual(c, { type: 'http', url: `http://localhost:${port}/mcp`, headers: { Authorization: `Bearer ${srv.tabToken(TAB)}`, 'X-AT-Tab': TAB } });
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.strictEqual(srv.configFor('../x'), null);
    assert.strictEqual(srv.configFor(null), null);
  });

  await t('4 initialize echoes a known protocol version, tools capability', async () => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/json/.test(r.headers['content-type']));
    assert.strictEqual(r.body.id, 1);
    assert.strictEqual(r.body.result.protocolVersion, '2025-03-26');
    assert.ok(r.body.result.capabilities.tools);
    assert.strictEqual(r.body.result.serverInfo.name, 'bantodesk');
    const u = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.strictEqual(u.body.result.protocolVersion, mcp.PROTOCOLS[0]);
  });

  await t('5 notifications get 202 and no body', async () => {
    const r = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body, '');
  });

  await t('6 tools/list has exactly notify with a message schema', async () => {
    const r = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = r.body.result.tools;
    assert.deepStrictEqual(tools.map((x) => x.name), ['notify']);
    assert.deepStrictEqual(tools[0].inputSchema.required, ['message']);
  });

  await t('7 tools/call notify reaches onNotify with kind (default done) and trimmed text', async () => {
    got.length = 0;
    const r = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'notify', arguments: { message: '  終わりました\u0007  ', kind: 'input' } } });
    assert.strictEqual(r.body.result.isError, undefined);
    assert.strictEqual(r.body.result.content[0].text, '通知しました。');
    await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'notify', arguments: { message: 'x'.repeat(900), kind: 'bogus' } } });
    assert.deepStrictEqual(got[0], { tab: TAB, kind: 'input', text: '終わりました' });
    assert.strictEqual(got[1].kind, 'done');
    assert.strictEqual(got[1].text.length, 500);
  });

  await t('8 empty message / unknown tool / unknown tab -> tool error, no notice', async () => {
    got.length = 0;
    const e1 = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'notify', arguments: { message: '  ' } } });
    assert.strictEqual(e1.body.result.isError, true);
    const e2 = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'rm', arguments: {} } });
    assert.strictEqual(e2.body.result.isError, true);
    const e3 = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'notify', arguments: { message: 'hi' } } }, OTHER);
    assert.strictEqual(e3.body.result.isError, true); // authed as OTHER, but no such tab in the app
    assert.strictEqual(got.length, 0);
  });

  await t('9 unknown method -> -32601; ping -> {}; bad JSON -> -32700; batch answered as an array', async () => {
    assert.strictEqual((await call({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).body.error.code, -32601);
    assert.deepStrictEqual((await call({ jsonrpc: '2.0', id: 10, method: 'ping' })).body.result, {});
    const bad = await req(port, { headers: auth(), body: '{nope' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error.code, -32700);
    const b = await call([{ jsonrpc: '2.0', id: 11, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 12, method: 'tools/list' }]);
    assert.ok(Array.isArray(b.body));
    assert.deepStrictEqual(b.body.map((x) => x.id), [11, 12]);
  });

  await t('10 no token / wrong token / token of another tab -> 401', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.strictEqual((await req(port, { headers: { Host: `localhost:${port}`, 'X-AT-Tab': TAB }, body })).status, 401);
    assert.strictEqual((await req(port, { headers: { ...auth(), Authorization: 'Bearer ' + '0'.repeat(64) }, body })).status, 401);
    assert.strictEqual((await req(port, { headers: { ...auth(), 'X-AT-Tab': OTHER }, body })).status, 401); // TAB's token, OTHER's header
    assert.strictEqual((await req(port, { headers: { ...auth(), 'X-AT-Tab': '../../x' }, body })).status, 401);
  });

  await t('11 browser / rebinding guards: Origin -> 403, foreign Host -> 403', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.strictEqual((await req(port, { headers: { ...auth(), Origin: 'http://localhost:3000' }, body })).status, 403);
    assert.strictEqual((await req(port, { headers: { ...auth(), Host: `evil.example:${port}` }, body })).status, 403);
    assert.strictEqual((await req(port, { headers: { ...auth(), Host: `127.0.0.1:${port}` }, body })).status, 200);
  });

  await t('12 GET -> 405, other path -> 404, body over 64 KB refused', async () => {
    assert.strictEqual((await req(port, { method: 'GET', headers: auth() })).status, 405);
    assert.strictEqual((await req(port, { pathName: '/other', headers: auth(), body: {} })).status, 404);
    let refused = false;
    try {
      const r = await req(port, { headers: auth(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70 * 1024) }) });
      refused = r.status !== 200;
    } catch {
      refused = true; // socket destroyed
    }
    assert.ok(refused);
  });

  await t('13 rate limit: the 21st notify in a minute is a tool error', async () => {
    const T2 = '22222222-2222-4333-8444-555555555555';
    const srv2 = await mcp.start({ onNotify: () => true });
    const h = { Host: `localhost:${srv2.port}`, Authorization: `Bearer ${srv2.tabToken(T2)}`, 'X-AT-Tab': T2 };
    let last;
    for (let i = 0; i < 21; i++) last = await req(srv2.port, { headers: h, body: { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'notify', arguments: { message: 'n' + i } } } });
    assert.strictEqual(last.body.result.isError, true);
    assert.strictEqual(srv2.calls.notify, 20);
    await srv2.close();
  });

  await t('14 tokens differ per server start (secret per run)', async () => {
    const srv3 = await mcp.start({});
    assert.notStrictEqual(srv3.tabToken(TAB), srv.tabToken(TAB));
    assert.notStrictEqual(srv3.port, srv.port);
    await srv3.close();
  });

  await t('15 claude-cmd: --mcp-config after --settings; quoted in the PowerShell line; left out when null', async () => {
    const a = claudeCmd.buildClaudeArgs({ mode: 'new', id: TAB, settingsPath: '/s.json', mcpConfigPath: '/m c.json' });
    assert.deepStrictEqual(a.slice(0, 4), ['--settings', '/s.json', '--mcp-config', '/m c.json']);
    assert.ok(!claudeCmd.buildClaudeArgs({ mode: 'new', id: TAB }).includes('--mcp-config'));
    assert.ok(claudeCmd.buildClaudeCmd({ mode: 'new', id: TAB, mcpConfigPath: "/a'b.json" }).includes("--mcp-config '/a''b.json'"));
    const posix = claudeCmd.launchSpec({ claude: { mode: 'new', id: TAB, mcpConfigPath: '/m.json' }, platform: 'darwin', env: { PATH: '', HOME: '' } });
    assert.ok(posix.args.includes('--mcp-config'));
    const shell = claudeCmd.launchSpec({ shell: '/bin/zsh', claude: { mode: 'new', id: TAB, mcpConfigPath: '/m.json' }, platform: 'darwin', env: {} });
    assert.ok(!shell.args.join(' ').includes('--mcp-config')); // no quoting for sh here, as --settings
  });

  await t('16 claude-cmd: the settings allow the notify tool (no dialog in an unattended session)', async () => {
    assert.ok(claudeCmd.claudeSettings().permissions.allow.includes('mcp__bantodesk__notify'));
  });

  await t('17 close removes the config files and stops listening', async () => {
    const f = path.join(dir, `${TAB}.json`);
    assert.ok(fs.existsSync(f));
    await srv.close();
    assert.ok(!fs.existsSync(f));
    let refused = false;
    try {
      await req(port, { headers: auth(), body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    } catch {
      refused = true;
    }
    assert.ok(refused);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
