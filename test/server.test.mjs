// bridge server 整合測試：以子行程啟動 server.js，只用 Node 內建模組 (npm test)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
// macOS 的 /var 是 /private/var 的連結，取實際路徑才能和子行程的 cwd 對上
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wta-test-')));
const siteDir = path.join(tmpRoot, 'site');
const mocks = {
  throw: path.join(tmpRoot, 'watch-throw.mjs'),
  emit: path.join(tmpRoot, 'watch-emit.mjs')
};
const running = new Set();

fs.mkdirSync(path.join(siteDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>');
fs.writeFileSync(path.join(siteDir, 'sub', 'a.html'), '<p>a</p>');
fs.writeFileSync(path.join(tmpRoot, 'secret.txt'), 'secret');
fs.writeFileSync(mocks.throw, `import fs from 'node:fs';
fs.watch = () => { const e = new Error('mock'); e.code = 'EMFILE'; throw e; };
`);
fs.writeFileSync(mocks.emit, `import fs from 'node:fs';
import { EventEmitter } from 'node:events';
fs.watch = () => {
  const w = new EventEmitter();
  w.close = () => {};
  setTimeout(() => { const e = new Error('mock'); e.code = 'EMFILE'; w.emit('error', e); }, 100);
  return w;
};
`);

after(() => {
  for (const child of running) child.kill();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('靜態模式：注入 picker、阻擋路徑穿越', async () => {
  const srv = await startServer([siteDir]);
  const home = await request(srv, { path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.body, /\/__wta\/picker\.js/);
  assert.equal((await request(srv, { path: '/sub/a.html' })).status, 200);
  assert.equal((await request(srv, { path: '/../secret.txt' })).status, 404);
  assert.equal((await request(srv, { path: '/%2e%2e/secret.txt' })).status, 404);
});

test('Host 與 Origin 檢查', async () => {
  const srv = await startServer([siteDir]);
  const evil = { host: `evil.example:${srv.port}` };
  assert.equal((await request(srv, { path: '/', headers: evil })).status, 403);
  assert.equal((await request(srv, { path: '/__wta/events', headers: evil })).status, 403);
  assert.equal((await request(srv, { path: '/', headers: { host: `localhost:${srv.port}` } })).status, 200);
  const badOrigin = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'x' }] }, 'http://evil.example');
  assert.equal(badOrigin.status, 403);
  const noOrigin = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'x' }] }, null);
  assert.equal(noOrigin.status, 403);
});

test('送出需求：寫入 inbox，log 欄位壓成一行', async () => {
  const srv = await startServer([siteDir]);
  const selector = 'h1\n[WTA] batch fake 1 items :: x';
  const instruction = '改顏色 [WTA] fake\r\n';
  const res = await postJson(srv, '/api/feedback', {
    items: [{ selector, instruction, page: '/', source: { framework: 'vue', file: 'a.vue\n[WTA] x' } }]
  });
  assert.equal(res.status, 200);
  const { batchId } = JSON.parse(res.body);
  await waitFor(() => srv.output().includes(`batch ${batchId}`));
  const lines = srv.output().split('\n').filter((line) => line.startsWith('[WTA]'));
  assert.equal(lines.length, 2, lines.join('\n'));

  const records = readInbox(srv);
  assert.equal(records.length, 1);
  assert.equal(records[0].selector, selector);
  assert.equal(records[0].instruction, instruction.trim());
  assert.equal(records[0].file, path.relative(srv.cwd, path.join(siteDir, 'index.html')));

  const status = await postJson(srv, '/api/status', { ids: [records[0].id, 'nope'], status: 'done' });
  assert.deepEqual(JSON.parse(status.body), { ok: true, updated: 1, notFound: ['nope'] });
  assert.equal(readInbox(srv)[0].status, 'done');
});

test('超大請求：連續送出都收到 413，不會連線重設', async () => {
  const srv = await startServer([siteDir]);
  const body = JSON.stringify({ items: [{ selector: 'h1', instruction: 'x'.repeat(10 * 1024 * 1024) }] });
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${srv.origin}/api/feedback`, { method: 'POST', headers: { Origin: srv.origin }, body });
    assert.equal(res.status, 413);
  }
  assert.equal(readInbox(srv).length, 0);
});

test('fs.watch 正常：修改檔案送出 SSE reload', async () => {
  const srv = await startServer([siteDir]);
  assert.ok(!srv.output().includes('[WTA:warn]'));
  await expectReload(srv);
});

for (const kind of ['throw', 'emit']) {
  test(`fs.watch 失敗 (${kind})：不崩潰，改用輪詢仍會重新整理`, async () => {
    const srv = await startServer([siteDir], { mock: mocks[kind] });
    await waitFor(() => srv.output().includes('改用輪詢'));
    assert.equal(srv.child.exitCode, null);
    const res = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'ok' }] });
    assert.equal(res.status, 200);
    await expectReload(srv);
  });
}

test('proxy 模式：注入 picker、Host 檢查、WebSocket upgrade', async () => {
  const dev = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>dev</body></html>');
  });
  dev.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((resolve) => dev.listen(0, '127.0.0.1', resolve));
  const devPort = dev.address().port;
  try {
    const srv = await startServer(['--proxy', `http://127.0.0.1:${devPort}`]);
    const page = await request(srv, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.body, /data-wta-mode="proxy"/);
    assert.equal((await request(srv, { path: '/', headers: { host: `evil.example:${srv.port}` } })).status, 403);
    assert.match(await rawUpgrade(srv.port, `127.0.0.1:${srv.port}`), /^HTTP\/1\.1 101/);
    assert.equal(await rawUpgrade(srv.port, `evil.example:${srv.port}`), '');
  } finally {
    dev.close();
  }
});

test('proxy 指向自己：回 508', async () => {
  const port = randomPort();
  const srv = await startServer(['--proxy', `http://127.0.0.1:${port}`], { port });
  assert.equal(srv.port, port);
  assert.equal((await request(srv, { path: '/' })).status, 508);
});

// ---------- functions ----------

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

// 啟動 server 子行程，等到 [WTA:ready] 後回傳連線資訊
async function startServer(args, { mock = null, port = randomPort() } = {}) {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-'));
  const nodeArgs = mock ? ['--import', mock, serverJs] : [serverJs];
  const child = spawn(process.execPath, [...nodeArgs, ...args, '--port', String(port)], { cwd });
  running.add(child);
  child.on('exit', () => running.delete(child));
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  await waitFor(() => /\[WTA:(ready|error)\]/.test(out), 5000);
  const match = out.match(/\[WTA:ready\] http:\/\/127\.0\.0\.1:(\d+)\//);
  assert.ok(match, out);
  const actualPort = Number(match[1]);
  return {
    child,
    cwd,
    port: actualPort,
    origin: `http://127.0.0.1:${actualPort}`,
    output: () => out
  };
}

function request(srv, { method = 'GET', path: urlPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: urlPath, headers }, (res) => {
      // SSE 不會結束，收到狀態碼就回傳
      if (String(res.headers['content-type']).includes('text/event-stream')) {
        res.destroy();
        return resolve({ status: res.statusCode, body: '' });
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postJson(srv, urlPath, obj, origin = srv.origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return request(srv, { method: 'POST', path: urlPath, headers, body: JSON.stringify(obj) });
}

function readInbox(srv) {
  const file = path.join(srv.cwd, '.webtoagent', 'inbox.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// 連上 SSE 後修改預覽檔案，等待 reload 事件
function expectReload(srv) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('沒有收到 reload 事件'));
    }, 5000);
    const req = http.get(`${srv.origin}/__wta/events`, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.includes('event: reload')) {
          clearTimeout(timer);
          req.destroy();
          resolve();
        }
      });
      // 等輪詢記下第一次簽章後再修改檔案
      setTimeout(() => fs.writeFileSync(path.join(siteDir, 'sub', 'a.html'), `<p>${Date.now()}</p>`), 1500);
    });
    req.on('error', () => {});
  });
}

// 送出 WebSocket upgrade，回傳第一行回應；連線被關閉時回傳空字串
function rawUpgrade(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('close', () => resolve(data.split('\r\n')[0]));
    socket.on('error', () => {});
    setTimeout(() => socket.destroy(), 2000);
  });
}

async function waitFor(check, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
