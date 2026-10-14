// webToAgent bridge server：提供 HTML 預覽 + 注入圈選工具 + 接收修改需求轉給 CLI
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.root || 'demo');
const startPort = Number(args.port || 5600);
const maxPortTries = 20;
let port = startPort;
const host = '127.0.0.1';
const inboxDir = path.resolve('.webtoagent');
const inboxFile = path.join(inboxDir, 'inbox.jsonl');
const maxBody = 256 * 1024;
const maxItems = 50;
const statusValues = ['pending', 'done', 'skipped'];
const injectTag = '<script src="/__wta/picker.js" defer></script>';

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

if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
  console.error(`[WTA:error] 找不到預覽資料夾：${rootDir}`);
  process.exit(1);
}
fs.mkdirSync(inboxDir, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);

  if (url.pathname === '/api/feedback' && req.method === 'POST') return handleFeedback(req, res);
  if (url.pathname === '/api/status' && req.method === 'POST') return handleStatus(req, res);
  if (url.pathname === '/__wta/events') return handleEvents(req, res);
  if (url.pathname === '/__wta/picker.js') return sendFile(res, path.join(appDir, 'client', 'picker.js'));
  if (url.pathname === '/__wta/picker.css') return sendFile(res, path.join(appDir, 'client', 'picker.css'));
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');

  const filePath = resolveInRoot(url.pathname);
  if (!filePath) return sendText(res, 404, 'Not Found');
  sendFile(res, filePath, true);
});

watchRoot();

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
  console.log(`[WTA:ready] http://${host}:${port}/  root=${rootDir}  inbox=${inboxFile}`);
});
server.listen(port, host);

// ---------- functions ----------

function parseArgs(list) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--port') result.port = list[++i];
    else if (!result.root) result.root = list[i];
  }
  return result;
}

// 將 URL 路徑轉為 rootDir 內的實體檔案，防止路徑穿越
function resolveInRoot(pathname) {
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
    let body = data;
    if (inject && ext === '.html') {
      const html = data.toString('utf8');
      body = html.includes('</body>') ? html.replace('</body>', `${injectTag}\n</body>`) : html + injectTag;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
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

// 只接受本機同源請求，避免其他網站跨站送出假需求
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

// 讀取 JSON body，超過上限或格式錯誤時直接回應錯誤，成功才呼叫 callback function
function readJsonBody(req, res, callback) {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBody) {
      sendJson(res, 413, { ok: false, error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
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
    const files = [...new Set(records.map((r) => r.file))].join(', ');
    const output = [`[WTA] batch ${batchId} ${records.length} items :: ${files}`];
    for (const r of records) output.push(`[WTA]   #${r.no} ${r.file} ${r.selector} :: ${r.instruction.replace(/\s+/g, ' ')}`);
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
  const page = String(item.page || '/');
  const filePath = resolveInRoot(page);
  return {
    id: `${batchId}-${no}`,
    batchId,
    no,
    file: filePath ? path.relative(process.cwd(), filePath) : null,
    page,
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

function createId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function handleEvents(req, res) {
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
function watchRoot() {
  let timer = null;
  fs.watch(rootDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const client of sseClients) client.write('event: reload\ndata: {}\n\n');
    }, 150);
  });
}
