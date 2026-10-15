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

test('防嵌入：注入 picker 的頁面帶 frame-ancestors，靜態資源不帶', async () => {
  const srv = await startServer([siteDir]);
  const home = await request(srv, { path: '/' });
  assert.equal(home.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.equal(home.headers['x-frame-options'], 'SAMEORIGIN');
  const picker = await request(srv, { path: '/__wta/picker.js' });
  assert.equal(picker.status, 200);
  assert.equal(picker.headers['content-security-policy'], undefined);
});

test('--log：輸出寫進指定檔案並自動建立資料夾', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-'));
  const logFile = path.join(cwd, 'logs', 'deep', 'server.log');
  const port = randomPort();
  const child = spawn(process.execPath, [serverJs, siteDir, '--port', String(port), '--log', 'logs/deep/server.log'], { cwd });
  running.add(child);
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stdout += chunk));
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  await waitFor(() => readLog().includes('[WTA:ready]'), 5000);
  const actualPort = Number(readLog().match(/127\.0\.0\.1:(\d+)\//)[1]);
  const srv = { port: actualPort, origin: `http://127.0.0.1:${actualPort}` };
  const res = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'log test' }] });
  assert.equal(res.status, 200);
  await waitFor(() => readLog().includes(':: log test'));
  assert.equal(stdout, '');
  child.kill();
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
    const headers = { 'Content-Type': 'text/html' };
    if (req.url === '/csp') headers['Content-Security-Policy'] = "script-src 'self'";
    res.writeHead(200, headers);
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
    assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self'");
    assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN');
    // dev server 原本的 CSP 保留，與 frame-ancestors 並列 (Node 會把重複標頭以逗號合併)
    const withCsp = await request(srv, { path: '/csp' });
    assert.equal(withCsp.headers['content-security-policy'], "script-src 'self', frame-ancestors 'self'");
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

test('JSON 不是物件時回 400，server 繼續執行', async () => {
  const srv = await startServer([siteDir]);
  for (const body of ['null', '[]', '1', '"x"']) {
    for (const urlPath of ['/api/feedback', '/api/status']) {
      const res = await request(srv, { method: 'POST', path: urlPath, headers: { Origin: srv.origin }, body });
      assert.equal(res.status, 400, `${urlPath} ${body}`);
    }
  }
  assert.equal(srv.child.exitCode, null);
  assert.equal((await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'ok' }] })).status, 200);
});

test('inbox 有 null 行或壞行時，/api/status 照常更新', async () => {
  const srv = await startServer([siteDir]);
  const res = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'ok' }] });
  const id = `${JSON.parse(res.body).batchId}-1`;
  const inbox = path.join(srv.cwd, '.webtoagent', 'inbox.jsonl');
  fs.appendFileSync(inbox, 'null\n{bad\n');
  const status = await postJson(srv, '/api/status', { ids: [id], status: 'done' });
  assert.deepEqual(JSON.parse(status.body), { ok: true, updated: 1, notFound: [] });
  assert.equal(srv.child.exitCode, null);
  const lines = fs.readFileSync(inbox, 'utf8').split('\n');
  assert.ok(lines.includes('null') && lines.includes('{bad'));
  assert.deepEqual(fs.readdirSync(path.dirname(inbox)).filter((f) => f.endsWith('.tmp')), []);
});

test('同一個專案只允許一個 server，結束後可重新啟動', async () => {
  const first = await startServer([siteDir]);
  const lockFile = path.join(first.cwd, '.webtoagent', 'server.lock');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).port, first.port);

  const second = await runServer(first.cwd, [siteDir, '--port', String(randomPort())]);
  assert.equal(second.code, 1);
  assert.match(second.out, /\[WTA:error\] 這個專案已有 webToAgent server 在執行/);
  assert.match(second.out, new RegExp(`127\\.0\\.0\\.1:${first.port}`));

  first.child.kill('SIGTERM');
  await waitFor(() => !fs.existsSync(lockFile));
  // 被強制終止留下的鎖檔 (行程已不存在) 不擋啟動
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, port: 1 }));
  const third = await startServer([siteDir], { cwd: first.cwd });
  assert.equal(third.child.exitCode, null);
});

test('鎖檔內容無法辨識時不接管，避免與執行中的 server 共用 inbox', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-'));
  fs.mkdirSync(path.join(cwd, '.webtoagent'));
  for (const content of ['', '{bad', '[]', '"x"']) {
    fs.writeFileSync(path.join(cwd, '.webtoagent', 'server.lock'), content);
    const result = await runServer(cwd, [siteDir, '--port', String(randomPort())]);
    assert.equal(result.code, 1, JSON.stringify(content));
    assert.match(result.out, /內容無法辨識/);
  }
});

test('留有舊鎖檔時多個 server 同時啟動，只有一個成功', async () => {
  for (let round = 0; round < 3; round++) {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-'));
    fs.mkdirSync(path.join(cwd, '.webtoagent'));
    fs.writeFileSync(path.join(cwd, '.webtoagent', 'server.lock'), JSON.stringify({ pid: 2147483646, port: 1 }));
    const results = await Promise.all(Array.from({ length: 6 }, () => startOrExit(cwd, [siteDir, '--port', String(randomPort())])));
    assert.equal(results.filter((r) => r === 'ready').length, 1, results.join(','));
  }
});

test('頁面腳本字串裡的 </body> 不影響注入位置', async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'site-'));
  fs.writeFileSync(path.join(dir, 'inscript.html'), `<!doctype html><html><body><script>window.__tpl = '<p></p></body></html>';</script></body></html>`);
  fs.writeFileSync(path.join(dir, 'trailer.html'), '<!doctype html><html><body><p>x</p></body></html>\n<!-- generated: </body> -->');
  const srv = await startServer([dir]);
  const page = await request(srv, { path: '/inscript.html' });
  assert.ok(page.body.includes(`window.__tpl = '<p></p></body></html>';</script>`), page.body);
  assert.ok(page.body.indexOf('/__wta/picker.js') > page.body.indexOf('</script>'));
  const trailer = await request(srv, { path: '/trailer.html' });
  assert.ok(trailer.body.indexOf('/__wta/picker.js') < trailer.body.indexOf('<!--'), trailer.body);
});

test('需求的檔案路徑只接受專案內', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'App.vue'), '');
  const srv = await startServer([siteDir], { cwd });
  const items = [
    ['~/.zshrc', null],
    ['../outside.vue', null],
    [path.join(tmpRoot, 'secret.txt'), null],
    [path.join(cwd, 'src', 'App.vue'), path.join('src', 'App.vue')],
    ['/src/Foo.vue', 'src/Foo.vue']
  ];
  const res = await postJson(srv, '/api/feedback', {
    items: items.map(([file]) => ({ selector: 'h1', instruction: 'x', source: { framework: 'vue', file, component: 'C', usedIn: { file } } }))
  });
  assert.equal(res.status, 200);
  const records = readInbox(srv);
  items.forEach(([file, expected], i) => {
    assert.equal(records[i].source.file, expected, file);
    assert.equal(records[i].source.usedIn ? records[i].source.usedIn.file : null, expected, `usedIn ${file}`);
    assert.equal(records[i].source.component, 'C');
  });
});

test('monorepo：在子資料夾啟動時，同一個 git repo 內的共用套件仍算專案內', async () => {
  const mono = fs.mkdtempSync(path.join(tmpRoot, 'mono-'));
  fs.mkdirSync(path.join(mono, '.git'));
  fs.mkdirSync(path.join(mono, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(path.join(mono, 'packages', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(mono, 'packages', 'ui', 'Button.vue'), '');
  const srv = await startServer([siteDir], { cwd: path.join(mono, 'apps', 'web') });
  const file = path.join(mono, 'packages', 'ui', 'Button.vue');
  const res = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'x', source: { framework: 'vue', file, component: 'Button' } }] });
  assert.equal(res.status, 200);
  assert.equal(readInbox(srv)[0].source.file, path.join('..', '..', 'packages', 'ui', 'Button.vue'));
});

test('computed 與 viewport 只保留 picker 會送的欄位', async () => {
  const srv = await startServer([siteDir]);
  const computed = { color: 'red', fontSize: 'x'.repeat(500), junk: 'y'.repeat(50000), nested: { a: 1 }, width: 10 };
  const res = await postJson(srv, '/api/feedback', { items: [{ selector: 'h1', instruction: 'x', computed, viewport: { w: 375, h: 812, junk: 'z' } }, { selector: 'h1', instruction: 'y', viewport: { w: '1' } }] });
  assert.equal(res.status, 200);
  const [first, second] = readInbox(srv);
  assert.deepEqual(first.computed, { color: 'red', fontSize: 'x'.repeat(200) });
  assert.deepEqual(first.viewport, { w: 375, h: 812 });
  assert.equal(second.viewport, null);
});

test('符號連結指到預覽資料夾外時回 404', async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'site-'));
  fs.writeFileSync(path.join(dir, 'a.html'), '<p>a</p>');
  fs.symlinkSync(path.join(tmpRoot, 'secret.txt'), path.join(dir, 'leak.txt'));
  fs.symlinkSync(path.join(dir, 'a.html'), path.join(dir, 'alias.html'));
  const srv = await startServer([dir]);
  assert.equal((await request(srv, { path: '/leak.txt' })).status, 404);
  assert.equal((await request(srv, { path: '/alias.html' })).status, 200);
});

test('install-skill.sh：目標是帶 / 的捷徑時只移除捷徑，不刪捷徑指向的資料夾', async () => {
  const base = fs.mkdtempSync(path.join(tmpRoot, 'install-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, '.webtoagent-skill'), '');
  fs.writeFileSync(path.join(real, 'keep.txt'), 'keep');
  fs.symlinkSync(real, path.join(base, 'link'));
  const script = path.resolve(path.dirname(serverJs), 'scripts', 'install-skill.sh');
  const result = await new Promise((resolve) => {
    const child = spawn('bash', [script, `${path.join(base, 'link')}/`]);
    child.on('exit', resolve);
  });
  assert.equal(result, 0);
  assert.equal(fs.readFileSync(path.join(real, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(base, 'link', 'server.js')));
});

// ---------- functions ----------

// 在指定資料夾啟動 server 並等它結束，回傳結束碼與輸出 (用於預期啟動失敗的情況)；5 秒沒結束就終止並回傳 code null
function runServer(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverJs, ...args], { cwd });
    running.add(child);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill(), 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ code, out });
    });
  });
}

// 啟動 server，回傳 'ready' 或 'exit'；ready 的會在測試結束時由 after() 結束
function startOrExit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverJs, ...args], { cwd });
    running.add(child);
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      if (out.includes('[WTA:ready]')) resolve('ready');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      running.delete(child);
      resolve('exit');
    });
  });
}

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

// 啟動 server 子行程，等到 [WTA:ready] 後回傳連線資訊
async function startServer(args, { mock = null, port = randomPort(), cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-')) } = {}) {
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
        return resolve({ status: res.statusCode, headers: res.headers, body: '' });
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
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
