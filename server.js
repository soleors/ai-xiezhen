// ============================================================
//  server.js —— AI 写真本地代理
//
//  为什么需要这个文件：
//    浏览器运行在沙箱里，读不到硬盘上的 .env（这是平台限制，不是代码问题）。
//    而 API Key 一旦写进前端 HTML，任何人 F12 就能看到、就能拿去花你的钱。
//    所以 Key 只能留在本机，由这个 Node 脚本读出来，替浏览器去请求即梦。
//
//  怎么启动（在本目录下打开终端）：
//    node server.js
//  然后浏览器打开：
//    http://localhost:3000
//
//  注意：不要双击 HTML 打开！那样走的是 file:// 协议，读不到 .env。
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PAGE = path.join(__dirname, 'ai-xiezhen.html');

// ---- API 四要素里固定的部分（这些不是密钥，写死安全） ----
const UPSTREAM = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const MODEL    = 'doubao-seedream-5-0-flash-260915';
const PROMPT   = '将这张自拍优化成真人写实风格的专业写真，保持人物面部特征不变，影楼级光影';
const SIZE     = '2K';

const MAX_BODY   = 25 * 1024 * 1024;  // 25MB，够一张手机原图转 base64
const UP_TIMEOUT = 150 * 1000;        // 给上游 150 秒（SPEC 要求 2 分钟内出图）

// ============================================================
//  读 .env —— 手写解析，不依赖任何第三方包（省去 npm install）
//  支持 KEY=VALUE、带引号、# 注释、Windows 换行符
// ============================================================
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const ENV     = readEnv(path.join(__dirname, '.env'));
const API_KEY = process.env.JIMENG_API_KEY || ENV.JIMENG_API_KEY || '';

if (!API_KEY) {
  console.log('');
  console.log('  ✗ 没读到 API Key，服务不能启动');
  console.log('  请在 ' + path.join(__dirname, '.env') + ' 里写入一行：');
  console.log('      JIMENG_API_KEY=你的火山方舟密钥');
  console.log('  （等号两边不要加空格，值不要带空格）');
  console.log('');
  process.exit(1);
}

// ============================================================
//  小工具
// ============================================================
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// 把请求体（含大段 base64）收完整
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('图片太大（超过 25MB），请换一张小一点的'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ============================================================
//  路由
// ============================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  // ---- ① GET / ：把前端页面发给浏览器 ----
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(PAGE, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('找不到 ai-xiezhen.html，请确认它和 server.js 在同一个文件夹。');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  // ---- ② POST /api/generate ：替浏览器带上 Key 去请求即梦 ----
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    readBody(req)
      .then(raw => {
        const payload = JSON.parse(raw);
        if (!payload.image) throw new Error('请求里没有 image 字段（自拍 base64）');

        return fetch(UPSTREAM, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + API_KEY,   // ← Key 只在这一行出现，且只在本机内存里
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({
            model: MODEL,
            prompt: payload.prompt || PROMPT,
            image: payload.image,
            size: SIZE,
            response_format: 'url',
            watermark: false
          }),
          signal: AbortSignal.timeout(UP_TIMEOUT)
        }).then(async r => {
          const text = await r.text();
          let data = null;
          try { data = JSON.parse(text); } catch (e) { /* 上游没返回 JSON */ }
          console.log('[generate] 上游 HTTP ' + r.status);
          // 原样把状态码和响应转给前端，前端的错误提示逻辑不用改
          sendJson(res, r.status, data || {
            error: { code: 'UpstreamNonJSON', message: text.slice(0, 500) }
          });
        });
      })
      .catch(err => {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        console.error('[generate] 失败:', err && err.message);
        sendJson(res, timedOut ? 504 : 500, {
          error: {
            code: timedOut ? 'ProxyTimeout' : 'ProxyError',
            message: timedOut
              ? '本地代理等上游返回超时（2 分钟），请重试。'
              : (err && err.message) || '未知错误'
          }
        });
      });
    return;
  }

  // ---- ③ GET /api/download ：把生成的图抓回来当附件返回，绕开跨域下载限制 ----
  if (req.method === 'GET' && url.pathname === '/api/download') {
    const target = url.searchParams.get('url') || '';
    let u;
    try { u = new URL(target); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('url 参数不合法'); return;
    }

    // 安全限制：只允许抓 AI 结果所在的官方域名。
    // 不加这道白名单，任何人都能用这个服务去访问内网地址（SSRF 漏洞）。
    const ALLOW = ['.volces.com', '.volcengine.com', '.ivolces.com'];
    if (u.protocol !== 'https:' || !ALLOW.some(h => u.hostname.endsWith(h))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('只允许下载 AI 生成结果所在的官方域名'); return;
    }

    fetch(target)
      .then(async r => {
        if (!r.ok) throw new Error('上游 HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': r.headers.get('content-type') || 'image/jpeg',
          'Content-Disposition': 'attachment; filename="ai-xiezhen.jpg"',
          'Content-Length': buf.length
        });
        res.end(buf);
      })
      .catch(err => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('抓取图片失败：' + err.message);
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('没有这个接口：' + url.pathname);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✅ AI 写真本地服务已启动');
  console.log('  👉 用浏览器打开：  http://localhost:' + PORT);
  console.log('');
  console.log('  API Key 已从 .env 读到（' + API_KEY.length + ' 位，值不显示）');
  console.log('  停止服务：在这个终端按 Ctrl + C');
  console.log('');
});
