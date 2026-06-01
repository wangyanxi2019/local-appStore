import dotenv from 'dotenv';

// 根据 NODE_ENV 加载对应配置文件（dev → .env.development，prod → .env.production）
// .env 作为公共回退，不会覆盖已加载的变量
const _nodeEnv = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${_nodeEnv}` });
dotenv.config(); // .env fallback
import express from 'express';
import http from 'http';
import https from 'https';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import multer from 'multer';
import Database from 'better-sqlite3';
import fs from 'fs-extra';
import cors from 'cors';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const BEHIND_PROXY = process.env.BEHIND_PROXY === 'true';

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
// 对外地址：优先取 APP_URL，其次本机 LAN IP（本地模式），最后 localhost
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
    build_type TEXT NOT NULL DEFAULT 'Debug',
    ipa_url TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE
  );
`);

try {
  db.exec(`ALTER TABLE versions ADD COLUMN build_type TEXT NOT NULL DEFAULT 'Debug'`);
} catch {
  // 列已存在，跳过
}

// ── 历史版本清理策略 ────────────────────────────────────────────────────────
const KEEP_VERSIONS = Math.max(1, parseInt(process.env.KEEP_VERSIONS || '3', 10));

function cleanupOldVersions(appId: number | string) {
  const all = db
    .prepare('SELECT id, ipa_url FROM versions WHERE app_id = ? ORDER BY id DESC')
    .all(appId) as Array<{ id: number; ipa_url: string }>;
  if (all.length <= KEEP_VERSIONS) return;

  const toDelete = all.slice(KEEP_VERSIONS);
  for (const v of toDelete) {
    const rel = v.ipa_url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOADS_DIR, ...rel.split('/'));
    fs.remove(filePath).catch(() => {});
    db.prepare('DELETE FROM versions WHERE id = ?').run(v.id);
    console.log(`[cleanup] Deleted version #${v.id} (app_id=${appId}, file=${rel})`);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// 信任代理（nginx 反代时获取真实 IP）
if (BEHIND_PROXY) app.set('trust proxy', 1);

// Multer for icon / single-shot ipa upload
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

// Multer for chunked upload — memory storage, 20 MB per chunk
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const CHUNKS_DIR = path.join(UPLOADS_DIR, 'chunks');
fs.ensureDirSync(CHUNKS_DIR);

// 供前端获取对外可访问的 baseUrl 及部署模式
app.get('/api/base-url', (_req, res) => {
  res.json({ baseUrl: getBaseUrl(), behindProxy: BEHIND_PROXY });
});

// 供 iPhone 下载并信任自签名证书（仅本地模式有效）
let sslCertPem: string | null = null;
app.get('/api/install-cert', (_req, res) => {
  if (!sslCertPem) {
    return res.status(503).send('Not available in proxy mode');
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
  const appData = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!appData) return res.status(404).json({ error: 'App not found' });

  const versions = db.prepare('SELECT * FROM versions WHERE app_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...appData, versions });
});

app.post('/api/apps/:id/versions', upload.single('ipa'), (req, res) => {
  const { version_number, build_number, build_type, notes } = req.body;
  const ipa_url = req.file ? `/uploads/ipas/${req.file.filename}` : null;

  if (!ipa_url) return res.status(400).json({ error: 'IPA file is required' });

  db.prepare('INSERT INTO versions (app_id, version_number, build_number, build_type, ipa_url, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, version_number, build_number, build_type || 'Debug', ipa_url, notes);

  db.prepare('UPDATE apps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  cleanupOldVersions(req.params.id);

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
    const { uploadId, totalChunks, filename, app_id, version_number, build_number, build_type, notes } = req.body;
    if (!uploadId || !totalChunks || !filename || !app_id || !version_number) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(filename) || '.ipa';
    const finalFilename = uniqueSuffix + ext;
    const finalPath = path.join(IPAS_DIR, finalFilename);

    // 流式合并分片，避免整文件读入内存
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

    await fs.remove(chunkDir);

    const ipa_url = `/uploads/ipas/${finalFilename}`;
    db.prepare('INSERT INTO versions (app_id, version_number, build_number, build_type, ipa_url, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(app_id, version_number, build_number || '', build_type || 'Debug', ipa_url, notes || '');
    db.prepare('UPDATE apps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(app_id);
    cleanupOldVersions(app_id);

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
    res.json({ ok: true });
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

// 全局错误抓取
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

  // ── 反代模式（宝塔 Nginx 处理 SSL）────────────────────────────────────────
  if (BEHIND_PROXY) {
    const server = http.createServer(app);
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Server (HTTP) running on http://127.0.0.1:${PORT}`);
      console.log(`Public URL: ${getBaseUrl()}`);
      console.log('  Running behind reverse proxy — SSL handled by Nginx.');
    });
    return;
  }

  // ── 本地模式（自签名 HTTPS，手机局域网扫码安装）──────────────────────────
  const SSL_DIR = path.join(__dirname, 'ssl');
  const CERT_PATH = path.join(SSL_DIR, 'cert.pem');
  const KEY_PATH = path.join(SSL_DIR, 'key.pem');
  await fs.ensureDir(SSL_DIR);

  let certPem: string;
  let keyPem: string;

  if (await fs.pathExists(CERT_PATH) && await fs.pathExists(KEY_PATH)) {
    certPem = await fs.readFile(CERT_PATH, 'utf8');
    keyPem = await fs.readFile(KEY_PATH, 'utf8');
    console.log('  Reusing existing SSL certificate from ssl/');
  } else {
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

  const server = https.createServer({ key: keyPem, cert: certPem }, app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on https://localhost:${PORT}`);
    if (LAN_IP) {
      console.log(`  Phone install: https://${LAN_IP}:${PORT}`);
      console.log(`  Download cert: https://${LAN_IP}:${PORT}/api/install-cert`);
      console.log(`  Then: Settings → General → About → Certificate Trust Settings → enable trust.`);
    } else {
      console.log(`  Could not detect LAN IP. Set APP_URL=https://YOUR_IP:${PORT} in .env`);
    }
  });
}

startServer();
