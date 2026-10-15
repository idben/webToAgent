// webToAgent bridge server：提供 HTML 預覽 + 注入圈選工具 + 接收修改需求轉給 CLI
// 靜態模式：node server.js <資料夾>；proxy 模式：node server.js --proxy http://localhost:5173 (Vue / React 等 dev server)
// --log <檔案>：輸出寫到檔案而非 stdout
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (args.log) setupLogFile(path.resolve(args.log));
const proxyTarget = args.proxy !== undefined ? parseProxyTarget(args.proxy) : null;
const rootDir = proxyTarget ? null : path.resolve(args.root || 'demo');
const startPort = Number(args.port || 5600);
const maxPortTries = 20;
let port = startPort;
const host = '127.0.0.1';
const inboxDir = path.resolve('.webtoagent');
const inboxFile = path.join(inboxDir, 'inbox.jsonl');
const lockFile = path.join(inboxDir, 'server.lock');
const maxBody = 256 * 1024;
const maxDrain = 32 * 1024 * 1024;
const pollInterval = 1000;
const maxPollFiles = 5000;
const pollSkip = new Set(['node_modules', '.git', '.webtoagent']);
const maxItems = 50;
const statusValues = ['pending', 'done', 'skipped'];
// 與 client/picker.js 的 pickComputed 相同
const computedKeys = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'margin', 'padding', 'display', 'width', 'height'];
const injectTag = proxyTarget
  ? '<script src="/__wta/picker.js" data-wta-mode="proxy" defer></script>'
  : '<script src="/__wta/picker.js" defer></script>';
const loopHeader = 'x-webtoagent-proxy';
// 注入 picker 的頁面不讓其他網站用 iframe 嵌入；用 self 讓專案自己的 iframe 仍可運作
const frameHeaders = {
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN'
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const sseClients = new Set();

if (rootDir && (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory())) {
  console.error(`[WTA:error] 找不到預覽資料夾：${rootDir}`);
  process.exit(1);
}
const realRootDir = rootDir ? fs.realpathSync.native(rootDir) : null;
const projectRoot = findProjectRoot();
fs.mkdirSync(inboxDir, { recursive: true });
acquireLock();

const server = http.createServer((req, res) => {
  if (!isAllowedHost(req)) return sendText(res, 403, 'Forbidden host');
  const url = new URL(req.url, `http://${host}:${port}`);

  if (url.pathname === '/api/feedback' && req.method === 'POST') return handleFeedback(req, res);
  if (url.pathname === '/api/status' && req.method === 'POST') return handleStatus(req, res);
  if (url.pathname === '/__wta/events') return handleEvents(req, res);
  if (url.pathname === '/__wta/picker.js') return sendFile(res, path.join(appDir, 'client', 'picker.js'));
  if (url.pathname === '/__wta/picker.css') return sendFile(res, path.join(appDir, 'client', 'picker.css'));
  if (url.pathname === '/__wta/tailwind-colors.js') return sendFile(res, path.join(appDir, 'client', 'tailwind-colors.js'));
  if (proxyTarget) return proxyRequest(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');

  const filePath = resolveInRoot(url.pathname);
  if (!filePath) return sendText(res, 404, 'Not Found');
  sendFile(res, filePath, true);
});

// proxy 模式畫面更新交給 dev server 的 HMR，不監看資料夾
if (proxyTarget) server.on('upgrade', proxyUpgrade);
else watchRoot();

// port 被占用時自動往後找，實際使用的 port 印在 [WTA:ready] 行
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < startPort + maxPortTries - 1) {
    port++;
    server.listen(port, host);
    return;
  }
  const reason = err.code === 'EADDRINUSE' ? `port ${startPort}～${port} 都已被使用，請用 --port 指定` : err.message;
  console.error(`[WTA:error] ${reason}`);
  process.exit(1);
});
server.on('listening', () => {
  writeLock({ pid: process.pid, port });
  const mode = proxyTarget ? `proxy=${proxyTarget.origin}` : `root=${rootDir}`;
  console.log(`[WTA:ready] http://${host}:${port}/  ${mode}  inbox=${inboxFile}`);
});
server.listen(port, host);

// ---------- functions ----------

// 同一個 inbox 只允許一個 server：handleStatus 會整份改寫 inbox，兩個 server 同時寫會互相蓋掉需求
// 鎖檔內容先寫進暫存檔再用 hard link 建立，建立的瞬間內容就完整，不會有「檔案存在但是空的」空窗
function acquireLock() {
  const tmp = `${lockFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));
  const fail = (message) => {
    fs.rmSync(tmp, { force: true });
    console.error(`[WTA:error] ${message}`);
    process.exit(1);
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (createExclusive(tmp, lockFile)) {
      fs.rmSync(tmp, { force: true });
      process.on('exit', releaseLock);
      // 以訊號結束時仍經過 exit 事件移除鎖檔，結束碼維持 128 + 訊號編號
      for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(signal, () => process.exit(code));
      return;
    }
    const other = readLock();
    if (other === undefined) continue; // 鎖檔剛好被移除，重試
    if (other === null) fail(`${lockFile} 內容無法辨識，可能有其他 webToAgent server 在執行；確認沒有之後刪除它再啟動`);
    if (isAlive(other.pid)) {
      fail(other.port
        ? `這個專案已有 webToAgent server 在執行 (pid ${other.pid}，網址 http://${host}:${other.port}/)，兩個 server 共用 inbox 會遺失需求，請沿用它；網址連不上時，確認沒有其他 webToAgent server 後刪除 ${lockFile} 再啟動`
        : `鎖檔記錄的 pid ${other.pid} 仍在執行，但無法確認是不是 webToAgent server；確認沒有其他 webToAgent server 後刪除 ${lockFile} 再啟動`);
    }
    // 上一個 server 沒有正常結束 (例：被強制終止) 留下的鎖檔
    takeOverStaleLock(other.pid, tmp);
  }
  fail(`無法建立 ${lockFile}`);
}

// 接管陳舊鎖檔時另外取得一個接管鎖，同一時間只有一個行程能刪除舊鎖，避免兩個行程先後刪掉對方剛建立的鎖
function takeOverStaleLock(stalePid, tmp) {
  const takeoverFile = `${lockFile}.takeover`;
  if (!createExclusive(tmp, takeoverFile)) {
    // 另一個行程正在接管；接管鎖超過 5 秒視為殘留
    try {
      if (Date.now() - fs.statSync(takeoverFile).mtimeMs > 5000) fs.rmSync(takeoverFile, { force: true });
    } catch {
      // 已被移除
    }
    sleepSync(50);
    return;
  }
  try {
    const current = readLock();
    if (current && current.pid === stalePid) fs.rmSync(lockFile, { force: true });
  } finally {
    fs.rmSync(takeoverFile, { force: true });
  }
}

// 以 hard link 建立檔案：目標已存在時失敗，成功時內容與來源相同；不支援 hard link 的檔案系統改用 wx 寫入
function createExclusive(source, target) {
  try {
    fs.linkSync(source, target);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
  }
  try {
    fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 鎖檔不存在回傳 undefined，內容無法解析回傳 null
function readLock() {
  let text;
  try {
    text = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? undefined : null;
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// 寫暫存檔再換名，讀的一方不會讀到寫到一半的內容
function writeLock(data) {
  const tmp = `${lockFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, lockFile);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

function releaseLock() {
  const lock = readLock();
  if (lock && lock.pid === process.pid) fs.rmSync(lockFile, { force: true });
}

// EPERM 代表行程存在但不能送訊號 (例：Claude Code 沙箱裡每個指令各自隔離)，仍視為執行中
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function parseArgs(list) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--port') result.port = list[++i];
    else if (list[i] === '--proxy') result.proxy = list[++i] || '';
    else if (list[i] === '--log') result.log = list[++i];
    else if (!result.root) result.root = list[i];
  }
  return result;
}

// 輸出改為同步附加到檔案，啟動指令不需要 shell 導向，沙箱的 excludedCommands 才對得上
function setupLogFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (...items) => fs.appendFileSync(file, util.format(...items) + '\n');
  console.log = write;
  console.error = write;
  process.on('uncaughtException', (err) => {
    write(`[WTA:error] ${oneLine(err.stack || err)}`);
    process.exit(1);
  });
}

// proxy 目標只允許本機 dev server，不轉送到外部網站
function parseProxyTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    target = null;
  }
  if (!target || target.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(target.hostname)) {
    console.error(`[WTA:error] --proxy 只接受 http://localhost 或 http://127.0.0.1 的網址：${value}`);
    process.exit(1);
  }
  return target;
}

// 一般 HTTP 請求轉送到 dev server；text/html 回應插入圈選工具，其他原樣回傳
function proxyRequest(req, res) {
  if (req.headers[loopHeader]) return sendText(res, 508, 'Loop Detected：--proxy 指向了 webToAgent 自己\n--proxy points to webToAgent itself');
  const headers = { ...req.headers, host: proxyTarget.host, [loopHeader]: '1' };
  // 不接受壓縮，HTML 才能直接插入
  delete headers['accept-encoding'];
  const proxyReq = http.request({
    hostname: proxyTarget.hostname,
    port: proxyTarget.port || 80,
    method: req.method,
    path: req.url,
    headers
  }, (proxyRes) => {
    const type = String(proxyRes.headers['content-type'] || '');
    const canInject = type.includes('text/html') && !proxyRes.headers['content-encoding'] && req.method !== 'HEAD';
    if (!canInject) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = injectPicker(Buffer.concat(chunks).toString('utf8'));
      const outHeaders = { ...proxyRes.headers, 'cache-control': 'no-store', 'x-frame-options': frameHeaders['x-frame-options'] };
      // dev server 原本的 CSP 保留，另外加一條 frame-ancestors (瀏覽器兩條都套用)
      const csp = proxyRes.headers['content-security-policy'];
      outHeaders['content-security-policy'] = csp ? [].concat(csp, frameHeaders['content-security-policy']) : frameHeaders['content-security-policy'];
      delete outHeaders['content-length'];
      delete outHeaders['transfer-encoding'];
      delete outHeaders.etag;
      outHeaders['content-length'] = Buffer.byteLength(body);
      res.writeHead(proxyRes.statusCode, outHeaders);
      res.end(body);
    });
  });
  proxyReq.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    sendText(res, 502, `Bad Gateway：無法連到 dev server ${proxyTarget.origin} (${err.code || err.message})\nCannot reach the dev server ${proxyTarget.origin}`);
  });
  req.pipe(proxyReq);
}

// WebSocket upgrade 轉送 (Vite HMR 等)，連上後兩端 socket 直接對接
function proxyUpgrade(req, socket, head) {
  if (req.headers[loopHeader] || !isAllowedHost(req)) return socket.destroy();
  const proxyReq = http.request({
    hostname: proxyTarget.hostname,
    port: proxyTarget.port || 80,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: proxyTarget.host, [loopHeader]: '1' }
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) lines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  // dev server 拒絕 upgrade 時，把狀態碼回給瀏覽器後關閉
  proxyReq.on('response', (proxyRes) => {
    socket.end(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n\r\n`);
    proxyRes.resume();
  });
  proxyReq.on('error', () => socket.destroy());
  socket.on('error', () => proxyReq.destroy());
  proxyReq.end();
}

// 插在最後一個 </body> 前：頁面腳本的字串裡也可能出現 </body>，插在第一個會把腳本切斷
// 只在最後一個 </html> 之前找，</html> 之後的註解 (例：產生器資訊) 裡出現 </body> 也不影響
function injectPicker(html) {
  const end = html.lastIndexOf('</html>');
  const index = html.lastIndexOf('</body>', end === -1 ? Infinity : end);
  return index === -1 ? html + injectTag : `${html.slice(0, index)}${injectTag}\n${html.slice(index)}`;
}

// 將 URL 路徑轉為 rootDir 內的實體檔案，防止路徑穿越
function resolveInRoot(pathname) {
  if (!rootDir) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  let target = path.resolve(rootDir, '.' + decoded);
  if (target !== rootDir && !target.startsWith(rootDir + path.sep)) return null;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  // 符號連結可能指到預覽資料夾外，以實際路徑再檢查一次，之後也讀實際路徑 (檢查後才換成連結也讀不到外面)
  let real;
  try {
    real = fs.realpathSync.native(target);
  } catch {
    return null;
  }
  return real === realRootDir || real.startsWith(realRootDir + path.sep) ? real : null;
}

function sendFile(res, filePath, inject = false) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not Found');
    const isPage = inject && ext === '.html';
    const body = isPage ? injectPicker(data.toString('utf8')) : data;
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(isPage ? frameHeaders : {})
    });
    res.end(body);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Host 只接受本機位址，阻擋 DNS 重綁定 (DNS rebinding) 讓外站讀到預覽內容或轉送到 dev server
function isAllowedHost(req) {
  const value = req.headers.host;
  return value === `${host}:${port}` || value === `localhost:${port}`;
}

// 只接受本機同源請求，避免其他網站跨站送出假需求
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

// 讀取 JSON body，超過上限或格式錯誤時回應錯誤，成功才呼叫 callback function
// 超過上限時把剩餘內容讀完丟棄再回 413，直接切斷會讓瀏覽器收到連線重設而不是 413
function readJsonBody(req, res, callback) {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxDrain) return req.destroy();
    if (size <= maxBody) chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > maxBody) {
      res.setHeader('Connection', 'close');
      return sendJson(res, 413, { ok: false, error: 'payload too large' });
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' });
    }
    // null、陣列、數字等合法 JSON 也不是需求格式；null 直接取屬性會讓 server 結束
    if (!data || typeof data !== 'object' || Array.isArray(data)) return sendJson(res, 400, { ok: false, error: 'json object required' });
    callback(data);
  });
}

function handleFeedback(req, res) {
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' });

  readJsonBody(req, res, (data) => {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return sendJson(res, 400, { ok: false, error: 'items required' });
    if (items.length > maxItems) return sendJson(res, 400, { ok: false, error: `max ${maxItems} items` });

    const batchId = createId();
    const ts = new Date().toISOString();
    const records = [];
    for (const [i, item] of items.entries()) {
      const record = toRecord(item, batchId, i + 1, ts);
      if (!record) return sendJson(res, 400, { ok: false, error: `item #${i + 1}: instruction and selector required` });
      records.push(record);
    }

    // 同步寫入，避免與 handleStatus 的「讀出 → 寫回」交錯而遺失新需求
    const lines = records.map((r) => JSON.stringify(r) + '\n').join('');
    try {
      fs.appendFileSync(inboxFile, lines);
    } catch {
      return sendJson(res, 500, { ok: false, error: 'write failed' });
    }
    // 寫進 log 的欄位壓成一行，避免換行偽造出 [WTA] 通知行
    const files = [...new Set(records.map((r) => oneLine(describeTarget(r, false))))].join(', ');
    const output = [`[WTA] batch ${batchId} ${records.length} items :: ${files}`];
    for (const r of records) output.push(`[WTA]   #${r.no} ${oneLine(describeTarget(r, true))} ${oneLine(r.selector)} :: ${oneLine(r.instruction)}`);
    console.log(output.join('\n'));
    sendJson(res, 200, { ok: true, batchId, count: records.length });
  });
}

// 更新 inbox 中指定 id 的處理狀態，讓 inbox 本身就能看出哪些需求已處理
function handleStatus(req, res) {
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' });

  readJsonBody(req, res, (data) => {
    const ids = Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length) return sendJson(res, 400, { ok: false, error: 'ids required' });
    if (!statusValues.includes(data.status)) return sendJson(res, 400, { ok: false, error: `status must be one of ${statusValues.join(', ')}` });

    let content;
    try {
      content = fs.existsSync(inboxFile) ? fs.readFileSync(inboxFile, 'utf8') : '';
    } catch {
      return sendJson(res, 500, { ok: false, error: 'read failed' });
    }
    const pending = new Set(ids);
    const updatedAt = new Date().toISOString();
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return line;
      }
      if (!record || typeof record !== 'object' || !pending.has(record.id)) return line;
      pending.delete(record.id);
      return JSON.stringify({ ...record, status: data.status, updatedAt });
    });
    const updated = new Set(ids).size - pending.size;
    if (updated) {
      // 先寫暫存檔再換名，寫到一半中斷也不會留下截斷的 inbox
      const tmpFile = `${inboxFile}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmpFile, lines.join('\n'));
        fs.renameSync(tmpFile, inboxFile);
      } catch {
        fs.rmSync(tmpFile, { force: true });
        return sendJson(res, 500, { ok: false, error: 'write failed' });
      }
    }
    console.log(`[WTA:status] ${data.status} ${updated} items`);
    sendJson(res, 200, { ok: true, updated, notFound: [...pending] });
  });
}

// 驗證並整理單筆需求，必要欄位缺少時回傳 null
function toRecord(item, batchId, no, ts) {
  if (!item || typeof item !== 'object') return null;
  const instruction = typeof item.instruction === 'string' ? item.instruction.trim() : '';
  const selector = typeof item.selector === 'string' ? item.selector.trim() : '';
  if (!instruction || !selector) return null;
  const page = String(item.page || '/').slice(0, 1000);
  const source = toSource(item.source);
  let file = null;
  if (proxyTarget) file = source ? source.file : null;
  else {
    const filePath = resolveInRoot(page);
    file = filePath ? path.relative(process.cwd(), filePath) : null;
  }
  return {
    id: `${batchId}-${no}`,
    batchId,
    no,
    file,
    page,
    source,
    selector: selector.slice(0, 1000),
    outerHTML: String(item.outerHTML || '').slice(0, 2000),
    text: String(item.text || '').slice(0, 300),
    computed: toComputed(item.computed),
    instruction: instruction.slice(0, 2000),
    viewport: toViewport(item.viewport),
    ts,
    status: 'pending'
  };
}

// 驗證 picker 偵測到的元件原始檔資訊 (Vue / React 開發模式)，格式不符或全空時回傳 null
function toSource(value) {
  if (!value || typeof value !== 'object') return null;
  const source = { framework: pickText(value.framework, 20), ...toLocation(value), usedIn: null };
  if (!source.file && !source.component) return null;
  const usedIn = value.usedIn && typeof value.usedIn === 'object' ? toLocation(value.usedIn) : null;
  if (usedIn && usedIn.file) source.usedIn = usedIn;
  return source;
}

// 檔案、行號、元件名稱三個欄位的型別檢查與截斷 (source 與 usedIn 共用)
function toLocation(value) {
  const line = Number.isInteger(value.line) && value.line > 0 && value.line < 1e7 ? value.line : null;
  const file = pickText(value.file, 500);
  return { file: file && toProjectPath(file), line, component: pickText(value.component, 200) };
}

// 只保留 picker 會送的樣式欄位 (pickComputed)，避免頁面腳本塞入大量內容進 inbox
function toComputed(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const key of computedKeys) {
    if (typeof value[key] === 'string') result[key] = value[key].slice(0, 200);
  }
  return result;
}

function toViewport(value) {
  if (!value || typeof value !== 'object') return null;
  const size = (n) => (Number.isInteger(n) && n >= 0 && n < 1e5 ? n : null);
  const w = size(value.w);
  const h = size(value.h);
  return w === null || h === null ? null : { w, h };
}

function pickText(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

// 磁碟上存在的絕對路徑轉成相對於目前專案根目錄的路徑；網址式路徑 (例：/src/App.jsx) 去掉開頭的 / 或 ./
// 路徑來自頁面，可被竄改：落在專案外 (例：/etc/hosts、~/.zshrc) 一律回傳 null，不讓 Claude 去改專案外的檔案
// 專案範圍是 git 根目錄 (monorepo 在 apps/web 啟動時，packages/ 的共用元件仍算專案內)，不在 git repo 時用目前目錄
function toProjectPath(file) {
  if (file.startsWith('~')) return null;
  const cwd = process.cwd();
  let relative = file.replace(/^\.?\//, '');
  if (path.isAbsolute(file) && fs.existsSync(file)) {
    try {
      relative = path.relative(cwd, fs.realpathSync.native(file));
    } catch {
      return null;
    }
  }
  const resolved = path.resolve(cwd, relative);
  return resolved === projectRoot || resolved.startsWith(projectRoot + path.sep) ? relative : null;
}

// 從目前目錄往上找含 .git 的資料夾
function findProjectRoot() {
  const cwd = fs.realpathSync.native(process.cwd());
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}

function formatLocation(location) {
  return location.line ? `${location.file}:${location.line}` : location.file;
}

// stdout 顯示用：有原始檔就印檔案 (含行號)，React 19 只有元件名稱時印 <元件>，都沒有就印網址路徑
function describeTarget(record, withLine) {
  const { file, source } = record;
  if (file) {
    const target = withLine && proxyTarget && source && source.line ? `${file}:${source.line}` : file;
    return withLine && source && source.usedIn ? `${target} (用於 ${formatLocation(source.usedIn)})` : target;
  }
  if (source && source.component) {
    return withLine && source.usedIn ? `<${source.component}> (用於 ${formatLocation(source.usedIn)})` : `<${source.component}>`;
  }
  return record.page;
}

// 控制字元與 Unicode 行分隔符號換成空白，連續空白壓成一個
function oneLine(text) {
  return String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, ' ').trim();
}

function createId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function handleEvents(req, res) {
  // proxy 模式不提供自動重新整理；204 讓瀏覽器的 EventSource 停止重連
  if (proxyTarget) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// 預覽資料夾內檔案變更時通知頁面重新整理（debounce 避免連續寫檔觸發多次）
// 監看失敗 (沙箱阻擋、EMFILE 等) 改用輪詢，server 繼續執行
function watchRoot() {
  let timer = null;
  let watcher;
  try {
    watcher = fs.watch(rootDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(notifyReload, 150);
    });
  } catch (err) {
    return pollRoot(err);
  }
  watcher.on('error', (err) => {
    watcher.close();
    pollRoot(err);
  });
}

function notifyReload() {
  for (const client of sseClients) client.write('event: reload\ndata: {}\n\n');
}

// 每秒比對資料夾簽章 (路徑 + mtime + size)，只在有頁面連線時掃描；檔案過多時停用
function pollRoot(err) {
  console.log(`[WTA:warn] 無法監看資料夾變更 (${err.code || err.message})，改用輪詢 (每 ${pollInterval / 1000} 秒)`);
  let last = null;
  const timer = setInterval(() => {
    if (!sseClients.size) {
      last = null;
      return;
    }
    const signature = scanSignature(rootDir);
    if (signature === null) {
      clearInterval(timer);
      console.log(`[WTA:warn] 預覽資料夾檔案超過 ${maxPollFiles} 個，自動重新整理停用`);
      return;
    }
    if (last !== null && signature !== last) notifyReload();
    last = signature;
  }, pollInterval);
}

// 走訪資料夾組出簽章字串，超過檔案上限時回傳 null
function scanSignature(dir) {
  const parts = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (pollSkip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (parts.length >= maxPollFiles) return null;
      try {
        const stat = fs.statSync(full);
        parts.push(`${full}|${stat.mtimeMs}|${stat.size}`);
      } catch {
        // 掃描途中被刪除的檔案略過
      }
    }
  }
  return parts.sort().join('\n');
}
