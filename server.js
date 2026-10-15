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
const maxBody = 256 * 1024;
const maxDrain = 32 * 1024 * 1024;
const pollInterval = 1000;
const maxPollFiles = 5000;
const pollSkip = new Set(['node_modules', '.git', '.webtoagent']);
const maxItems = 50;
const statusValues = ['pending', 'done', 'skipped'];
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
fs.mkdirSync(inboxDir, { recursive: true });

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
  const mode = proxyTarget ? `proxy=${proxyTarget.origin}` : `root=${rootDir}`;
  console.log(`[WTA:ready] http://${host}:${port}/  ${mode}  inbox=${inboxFile}`);
});
server.listen(port, host);

// ---------- functions ----------

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

function injectPicker(html) {
  return html.includes('</body>') ? html.replace('</body>', `${injectTag}\n</body>`) : html + injectTag;
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
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
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
      if (!pending.has(record.id)) return line;
      pending.delete(record.id);
      return JSON.stringify({ ...record, status: data.status, updatedAt });
    });
    const updated = new Set(ids).size - pending.size;
    if (updated) {
      try {
        fs.writeFileSync(inboxFile, lines.join('\n'));
      } catch {
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
  if (proxyTarget) file = source && source.file ? toProjectPath(source.file) : null;
  else {
    const filePath = resolveInRoot(page);
    file = filePath ? path.relative(process.cwd(), filePath) : null;
  }
  if (source && source.usedIn && source.usedIn.file) source.usedIn.file = toProjectPath(source.usedIn.file);
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
    computed: typeof item.computed === 'object' && item.computed ? item.computed : {},
    instruction: instruction.slice(0, 2000),
    viewport: typeof item.viewport === 'object' && item.viewport ? item.viewport : null,
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
  return { file: pickText(value.file, 500), line, component: pickText(value.component, 200) };
}

function pickText(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

// 磁碟上存在的絕對路徑轉成相對於目前專案根目錄的路徑；網址式路徑 (例：/src/App.jsx) 去掉開頭的 / 或 ./
function toProjectPath(file) {
  if (path.isAbsolute(file) && fs.existsSync(file)) return path.relative(process.cwd(), file);
  return file.replace(/^\.?\//, '');
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
