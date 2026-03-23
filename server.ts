import 'dotenv/config';
import express from 'express';
import http from 'http';
import https from 'https';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { execSync, spawn } from 'child_process';
import multer from 'multer';
import Database from 'better-sqlite3';
import fs from 'fs-extra';
import cors from 'cors';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

/** 获取本机局域网 IP，供手机扫码安装时使用（手机无法访问 localhost） */
function getLocalNetworkIP(): string | null {
  const interfaces = os.networkInterfaces();
  if (!interfaces) return null;
  const isIPv4 = (f: string | number) => f === 'IPv4' || f === 4;
  const preferOrder = ['en0', 'en1', 'en2', 'eth0', 'wlan0'];
  for (const name of preferOrder) {
    const ifaces = interfaces[name];
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (isIPv4(iface.family) && !iface.internal && iface.address) {
        return iface.address;
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    const ifaces = interfaces[name];
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (isIPv4(iface.family) && !iface.internal && iface.address) {
        return iface.address;
      }
    }
  }
  return null;
}

const LAN_IP = getLocalNetworkIP();
const USE_NGROK = process.env.USE_NGROK === '1' || process.env.USE_NGROK === 'true';
// 安装链接的根 URL：ngrok 模式下由隧道地址覆盖；否则为 APP_URL 或本机 HTTPS
let _baseUrl = process.env.APP_URL || (LAN_IP ? `https://${LAN_IP}:${PORT}` : `https://localhost:${PORT}`);
function getBaseUrl() {
  return _baseUrl.replace(/\/$/, '');
}

// Ensure directories exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const ICONS_DIR = path.join(UPLOADS_DIR, 'icons');
const IPAS_DIR = path.join(UPLOADS_DIR, 'ipas');
fs.ensureDirSync(ICONS_DIR);
fs.ensureDirSync(IPAS_DIR);

// Database setup
const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    bundle_id TEXT NOT NULL UNIQUE,
    icon_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL,
    version_number TEXT NOT NULL,
    build_number TEXT,
    ipa_url TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE
  );
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'icon') cb(null, ICONS_DIR);
    else if (file.fieldname === 'ipa') cb(null, IPAS_DIR);
    else cb(new Error('Invalid field name'), '');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Multer for chunked upload — memory storage, max 200 MB per chunk for LAN uploads
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});
const CHUNKS_DIR = path.join(UPLOADS_DIR, 'chunks');
fs.ensureDirSync(CHUNKS_DIR);

// 供前端获取“对外可访问的 baseUrl”，手机扫码安装时必须用该地址
app.get('/api/base-url', (_req, res) => {
  res.json({ baseUrl: getBaseUrl() });
});

// 供 iPhone 下载并信任自签名证书（设置 → 通用 → 关于本机 → 证书信任设置）
let sslCertPem: string | null = null;
app.get('/api/install-cert', (_req, res) => {
  if (!sslCertPem) {
    return res.status(503).send('HTTPS cert not ready');
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="ipa-distribution.cer"');
  res.send(sslCertPem);
});

// API Routes
app.get('/api/apps', (req, res) => {
  const apps = db.prepare(`
    SELECT a.*, v.version_number as latest_version, v.created_at as last_upload_at
    FROM apps a
    LEFT JOIN (
      SELECT app_id, version_number, created_at
      FROM versions
      WHERE id IN (SELECT MAX(id) FROM versions GROUP BY app_id)
    ) v ON a.id = v.app_id
    ORDER BY a.updated_at DESC
  `).all();
  res.json(apps);
});

app.post('/api/apps', upload.single('icon'), (req, res) => {
  const { name, bundle_id } = req.body;
  const icon_url = req.file ? `/uploads/icons/${req.file.filename}` : null;

  try {
    const result = db.prepare('INSERT INTO apps (name, bundle_id, icon_url) VALUES (?, ?, ?)')
      .run(name, bundle_id, icon_url);
    res.json({ id: result.lastInsertRowid });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/apps/:id', (req, res) => {
  const appData = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!appData) return res.status(404).json({ error: 'App not found' });

  const versions = db.prepare('SELECT * FROM versions WHERE app_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...appData, versions });
});

app.post('/api/apps/:id/versions', upload.single('ipa'), (req, res) => {
  const { version_number, build_number, notes } = req.body;
  const ipa_url = req.file ? `/uploads/ipas/${req.file.filename}` : null;

  if (!ipa_url) return res.status(400).json({ error: 'IPA file is required' });

  db.prepare('INSERT INTO versions (app_id, version_number, build_number, ipa_url, notes) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, version_number, build_number, ipa_url, notes);

  db.prepare('UPDATE apps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

  res.json({ success: true });
});

// ── 分片上传接口 ──────────────────────────────────────────────────────────────

/** 接收单个分片：POST /api/upload/chunk */
app.post('/api/upload/chunk', chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body;
    if (!uploadId || chunkIndex === undefined || !req.file) {
      return res.status(400).json({ error: 'Missing uploadId, chunkIndex or chunk data' });
    }
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    await fs.ensureDir(chunkDir);
    const chunkPath = path.join(chunkDir, String(chunkIndex));
    await fs.writeFile(chunkPath, req.file.buffer);
    res.json({ ok: true, chunkIndex });
  } catch (err: any) {
    console.error('chunk upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** 合并分片并写入版本记录：POST /api/upload/complete */
app.post('/api/upload/complete', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { uploadId, totalChunks, filename, app_id, version_number, build_number, notes } = req.body;
    if (!uploadId || !totalChunks || !filename || !app_id || !version_number) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(filename) || '.ipa';
    const finalFilename = uniqueSuffix + ext;
    const finalPath = path.join(IPAS_DIR, finalFilename);

    // 顺序合并所有分片
    const writeStream = fs.createWriteStream(finalPath);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(chunkDir, String(i));
            const buf = await fs.readFile(chunkPath);
            writeStream.write(buf);
          }
          writeStream.end();
        } catch (e) {
          writeStream.destroy(e as Error);
        }
      })();
    });

    // 清理临时分片
    await fs.remove(chunkDir);

    const ipa_url = `/uploads/ipas/${finalFilename}`;
    db.prepare('INSERT INTO versions (app_id, version_number, build_number, ipa_url, notes) VALUES (?, ?, ?, ?, ?)')
      .run(app_id, version_number, build_number || '', ipa_url, notes || '');
    db.prepare('UPDATE apps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(app_id);

    res.json({ success: true });
  } catch (err: any) {
    console.error('upload complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** 清理中止的上传临时分片：DELETE /api/upload/abort/:uploadId */
app.delete('/api/upload/abort/:uploadId', async (req, res) => {
  try {
    const chunkDir = path.join(CHUNKS_DIR, req.params.uploadId);
    await fs.remove(chunkDir);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // 目录不存在也没关系
  }
});

// Manifest Plist Generator for OTA
app.get('/api/manifest/:versionId', (req, res) => {
  const version = db.prepare(`
    SELECT v.*, a.name, a.bundle_id, a.icon_url
    FROM versions v
    JOIN apps a ON v.app_id = a.id
    WHERE v.id = ?
  `).get(req.params.versionId) as any;

  if (!version) return res.status(404).send('Version not found');

  const base = getBaseUrl();
  const ipaUrl = `${base}${version.ipa_url}`;
  const iconUrl = version.icon_url ? `${base}${version.icon_url}` : `${base}/default-icon.png`;
  const escapeXml = (s: string) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  const safe = (key: keyof typeof version) => escapeXml(String(version[key] ?? ''));

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${ipaUrl}</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>display-image</string>
                    <key>url</key>
                    <string>${iconUrl}</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>full-size-image</string>
                    <key>url</key>
                    <string>${iconUrl}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${safe('bundle_id')}</string>
                <key>bundle-version</key>
                <string>${safe('version_number')}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${safe('name')}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

  res.set('Content-Type', 'application/xml');
  res.set('Content-Disposition', 'attachment; filename="manifest.plist"');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(plist);
});

// 静态文件：IPA 必须用 application/octet-stream，否则 iOS 可能报「无法安装，请稍后再试」
app.use('/uploads', express.static(UPLOADS_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.ipa')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="app.ipa"');
    }
  },
}));

// 全局错误抓取（防止 MulterError 返回 HTML 导致前端 parse 失败）
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Global Error Middleware:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Vite integration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (USE_NGROK) {
    const server = http.createServer(app);
    server.listen(PORT, '0.0.0.0', async () => {
      console.log(`Server (HTTP) running on http://localhost:${PORT}`);
      try {
        try {
          if (process.platform !== 'win32') execSync('pkill -f ngrok 2>/dev/null || true', { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 600));
        const binPath = path.join(__dirname, 'node_modules', 'ngrok', 'bin', 'ngrok');
        const child = spawn(binPath, ['http', String(PORT)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const getUrlFromApi = (): Promise<string> =>
          fetch('http://127.0.0.1:4040/api/tunnels')
            .then((r) => r.json() as Promise<{ tunnels?: Array<{ public_url: string }> }>)
            .then((j) => {
              const u = j.tunnels?.[0]?.public_url;
              if (u && u.startsWith('https://')) return u.replace(/\/$/, '');
              throw new Error('no tunnel');
            });
        let publicUrl: string | null = null;
        const fromStdout = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout')), 18000);
          const onData = (data: Buffer) => {
            const match = data.toString().match(/https:\/\/[a-z0-9-]+\.(ngrok(-free)?\.app|ngrok\.io)[^\s"'<>)*,]*/i);
            if (match) {
              clearTimeout(timeout);
              resolve(match[0].replace(/[.,)\]\s]+$/, ''));
            }
          };
          child.stdout?.on('data', onData);
          child.stderr?.on('data', onData);
          child.on('error', (e) => {
            clearTimeout(timeout);
            reject(e);
          });
        });
        try {
          publicUrl = await fromStdout;
        } catch {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            try {
              publicUrl = await getUrlFromApi();
              break;
            } catch {
              if (i === 29) throw new Error('ngrok tunnel not ready');
            }
          }
        }
        if (!publicUrl) throw new Error('ngrok tunnel not ready');
        publicUrl = publicUrl.replace(/\/$/, '');
        _baseUrl = publicUrl;
        console.log('');
        console.log('  ngrok tunnel (HTTPS):', publicUrl);
        console.log('  → Refresh the page in your browser, then scan the QR code on your phone to install.');
        console.log('');
      } catch (err) {
        console.error('  ngrok failed:', err);
        console.log('  Ensure no other ngrok is running (pkill -f ngrok). Or run ngrok manually: npx ngrok http 3000');
        console.log('  Then set APP_URL in .env to the ngrok URL and restart with npm run dev.');
      }
    });
    return;
  }

  // 证书持久化：首次生成后保存到磁盘，后续启动直接复用，避免 iPhone 每次重装证书
  const SSL_DIR = path.join(__dirname, 'ssl');
  const CERT_PATH = path.join(SSL_DIR, 'cert.pem');
  const KEY_PATH = path.join(SSL_DIR, 'key.pem');
  await fs.ensureDir(SSL_DIR);

  let certPem: string;
  let keyPem: string;

  if (await fs.pathExists(CERT_PATH) && await fs.pathExists(KEY_PATH)) {
    // 复用已有证书
    certPem = await fs.readFile(CERT_PATH, 'utf8');
    keyPem = await fs.readFile(KEY_PATH, 'utf8');
    console.log('  Reusing existing SSL certificate from ssl/');
  } else {
    // 首次生成并保存
    const altNames: Array<{ type: 1 | 2 | 6 | 7; value?: string; ip?: string }> = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ];
    if (LAN_IP) {
      altNames.push({ type: 2, value: LAN_IP }, { type: 7, ip: LAN_IP });
    }
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: LAN_IP || 'localhost' }],
      {
        algorithm: 'sha256',
        days: 3650,
        keySize: 2048,
        extensions: [
          { name: 'basicConstraints', cA: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'subjectAltName', altNames },
        ],
      } as any
    );
    certPem = pems.cert;
    keyPem = pems.private;
    await fs.writeFile(CERT_PATH, certPem, 'utf8');
    await fs.writeFile(KEY_PATH, keyPem, 'utf8');
    console.log('  Generated new SSL certificate → ssl/cert.pem');
  }

  sslCertPem = certPem;

  const server = https.createServer(
    { key: keyPem, cert: certPem },
    app
  );
  server.listen(PORT, '0.0.0.0', () => {
    const url = process.env.APP_URL;
    if (url && url.startsWith('http://')) {
      console.log('  Warning: APP_URL should use https:// for iOS install. Update .env to https://YOUR_IP:3000');
    }
    console.log(`Server running on https://localhost:${PORT}`);
    if (LAN_IP) {
      console.log(`  Phone install: https://${LAN_IP}:${PORT}`);
      console.log(`  On iPhone: open the URL above in Safari first → accept certificate → then scan QR to install.`);
      console.log(`  Or download cert: https://${LAN_IP}:${PORT}/api/install-cert → install → Settings → General → About → Certificate Trust Settings → enable trust.`);
    } else {
      console.log(`  Could not detect LAN IP. Set APP_URL=https://YOUR_IP:${PORT} in .env for phone install.`);
    }
  });
}

startServer();
