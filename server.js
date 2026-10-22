'use strict';

/**
 * 就爱读 · 92Reader
 * 零依赖单文件服务：静态页面 + 网页正文抓取代理
 *
 * 抓取必须由服务端完成——浏览器的跨域限制（CORS）无法在前端绕过。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------------- 文本清洗 ---------------- */

const NAMED_ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&ldquo;': '\u201c',
  '&rdquo;': '\u201d', '&lsquo;': '\u2018', '&rsquo;': '\u2019',
  '&mdash;': '\u2014', '&ndash;': '\u2013', '&hellip;': '\u2026',
  '&middot;': '\u00b7', '&times;': '\u00d7',
};

function decodeEntities(s) {
  return s.replace(/&(?:[a-z]+|#x?[0-9a-f]+);/gi, (m) => {
    const lower = m.toLowerCase();
    if (NAMED_ENTITIES[lower]) return NAMED_ENTITIES[lower];
    const hex = /^&#x([0-9a-f]+);$/i.exec(m);
    if (hex) {
      try { return String.fromCodePoint(parseInt(hex[1], 16)); } catch (e) { return m; }
    }
    const dec = /^&#(\d+);$/.exec(m);
    if (dec) {
      try { return String.fromCodePoint(parseInt(dec[1], 10)); } catch (e) { return m; }
    }
    return m;
  });
}

function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '');
}

/** 把 HTML 片段压成纯文本行 */
function htmlToLines(fragment) {
  const s = fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|pre|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[\t\u00a0 ]+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/** 选取最可能是正文的容器 */
function pickContainer(clean) {
  const preferred =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(clean) ||
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(clean);
  if (preferred && htmlToLines(preferred[1]).join('').length > 200) {
    return preferred[1];
  }

  const re = /<div\b[^>]*>([\s\S]*?)<\/div>/gi;
  let best = null;
  let bestScore = -1;
  let m;
  while ((m = re.exec(clean))) {
    const inner = m[1];
    if (inner.length > 200000) continue;
    const lines = htmlToLines(inner);
    const textLen = lines.join('').length;
    if (textLen < 120) continue;
    const pCount = (inner.match(/<p\b/gi) || []).length;
    const linkText = (inner.match(/<a\b[^>]*>([\s\S]*?)<\/a>/gi) || []).join('');
    const score = textLen + pCount * 80 - linkText.length * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = inner;
    }
  }
  return best || clean;
}

const NOISE_RE =
  /(登录|注册|登录后可|版权所有|Copyright|免责声明|相关阅读|推荐阅读|延伸阅读|Read more|Subscribe|Sign in|Sign up|Cookie|Advertisement|点击查看|扫一扫|长按|关注我们|\u516c\u4f17\u53f7)/i;

function isNoise(line) {
  if (line.length < 2) return true;
  if (/^https?:\/\/\S+$/.test(line)) return true;
  if (NOISE_RE.test(line) && line.length < 40) return true;
  return false;
}

function detectLang(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk > latin * 0.3 ? 'zh' : 'en';
}

function extract(html, fallbackUrl) {
  const clean = stripNoise(html);
  const titleRaw =
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] ||
    (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(clean) || [])[1] ||
    '';
  const title = decodeEntities(titleRaw).replace(/\s+/g, ' ').trim() || fallbackUrl;

  const container = pickContainer(clean);
  let lines = htmlToLines(container);
  if (lines.join('').length < 120) lines = htmlToLines(clean);
  lines = lines.filter((l) => !isNoise(l));

  const text = lines.join('\n');
  return { title, lines, text, lang: detectLang(text) };
}

/* ---------------- 抓取 ---------------- */

async function grab(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: '目标站点返回 ' + res.status };

    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    let charset = (/charset=["']?([\w-]+)/i.exec(ct) || [])[1];
    if (!charset) {
      const head = buf.subarray(0, 4096).toString('latin1');
      charset = (/charset=["']?([\w-]+)/i.exec(head) || [])[1];
    }
    charset = (charset || 'utf-8').toLowerCase();

    let text;
    try {
      text = new TextDecoder(charset).decode(buf);
    } catch (e) {
      text = buf.toString('utf8');
    }
    return { ok: true, text, contentType: ct, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

function isPlainContent(ct) {
  return /^text\/(plain|markdown|x-markdown)/i.test(ct) || /application\/json/i.test(ct);
}

/* ---------------- 路由 ---------------- */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'app.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    res.writeHead(400).end('bad request');
    return;
  }

  if (u.pathname === '/api/fetch') {
    const target = u.searchParams.get('url');
    if (!target) return sendJSON(res, 400, { ok: false, error: '缺少 url 参数' });

    let parsed;
    try {
      parsed = new URL(target);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: '链接格式不正确' });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return sendJSON(res, 400, { ok: false, error: '仅支持 http / https 链接' });
    }

    let g;
    try {
      g = await grab(target);
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '抓取超时（20 秒）' : '抓取失败：' + (e && e.message);
      return sendJSON(res, 200, { ok: false, error: msg });
    }
    if (!g.ok) return sendJSON(res, 200, { ok: false, error: g.error });

    if (isPlainContent(g.contentType)) {
      const text = g.text.trim();
      return sendJSON(res, 200, {
        ok: true,
        title: parsed.hostname + ' 的文本',
        text,
        lines: text.split(/\n+/).map((x) => x.trim()).filter(Boolean),
        lang: detectLang(text),
        kind: 'plain',
      });
    }

    const out = extract(g.text, parsed.href);
    if (!out.text || out.text.length < 20) {
      return sendJSON(res, 200, {
        ok: false,
        error: '页面正文提取为空，可能是动态渲染页面。请改用「粘贴文本」导入。',
      });
    }
    return sendJSON(res, 200, Object.assign({ ok: true, kind: 'html', source: g.finalUrl }, out));
  }

  if (u.pathname === '/api/health') return sendJSON(res, 200, { ok: true });

  serveStatic(res, u.pathname);
});

server.listen(PORT, () => {
  console.log('92Reader running at http://localhost:' + PORT);
});
