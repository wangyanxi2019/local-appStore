import { useState, useEffect, useRef } from 'react';
import { Plus, Upload, QrCode, ArrowLeft, Package, Clock, Shield, ChevronRight, Info, Zap, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

/** Cyberpunk 方角装饰 */
function CyberCorners({ color = '#00FFFF', size = 'md' }: { color?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'w-2.5 h-2.5' : size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5';
  const bw = size === 'sm' ? 'border-[1.5px]' : 'border-2';
  return (
    <>
      <span className={`absolute top-0 left-0 ${sz} ${bw} border-r-0 border-b-0`} style={{ borderColor: color }} />
      <span className={`absolute top-0 right-0 ${sz} ${bw} border-l-0 border-b-0`} style={{ borderColor: color }} />
      <span className={`absolute bottom-0 left-0 ${sz} ${bw} border-r-0 border-t-0`} style={{ borderColor: color }} />
      <span className={`absolute bottom-0 right-0 ${sz} ${bw} border-l-0 border-t-0`} style={{ borderColor: color }} />
    </>
  );
}

/** Cyberpunk 卡片容器（统一使用 cyan 风格） */
function CyberCard({
  children,
  className,
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative bg-[#0D0D0D] border border-[rgba(0,255,255,0.25)] transition-all duration-200',
        hover && 'hover:border-[rgba(0,255,255,0.6)] hover:shadow-[0_0_16px_rgba(0,255,255,0.15)]',
        className
      )}
    >
      <CyberCorners color="#00FFFF" />
      {children}
    </div>
  );
}

/** Cyberpunk 霓虹按钮 */
function CyberButton({
  children,
  onClick,
  type = 'button',
  variant = 'cyan',
  disabled = false,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'cyan' | 'ghost' | 'red';
  disabled?: boolean;
  className?: string;
}) {
  const styles = {
    cyan: 'bg-[#00FFFF]/10 border border-[#00FFFF]/60 text-[#00FFFF] hover:bg-[#00FFFF]/20 hover:border-[#00FFFF] hover:shadow-[0_0_12px_rgba(0,255,255,0.4)]',
    ghost: 'bg-transparent border border-[rgba(0,255,255,0.2)] text-[#00FFFF]/60 hover:border-[rgba(0,255,255,0.5)] hover:text-[#00FFFF]',
    red: 'bg-[#FF4D4D]/10 border border-[#FF4D4D]/60 text-[#FF4D4D] hover:bg-[#FF4D4D]/20 hover:border-[#FF4D4D] hover:shadow-[0_0_12px_rgba(255,77,77,0.4)]',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center gap-2 px-5 py-2.5 font-mono text-sm tracking-widest transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        styles[variant],
        className
      )}
    >
      {children}
    </button>
  );
}

interface AppVersion {
  id: number;
  version_number: string;
  build_number: string;
  build_type: 'Debug' | 'Release';
  ipa_url: string;
  notes: string;
  created_at: string;
}

interface AppInfo {
  id: number;
  name: string;
  bundle_id: string;
  icon_url: string | null;
  latest_version?: string;
  last_upload_at?: string;
  versions?: AppVersion[];
}

const CLICK_THROTTLE_MS = 1000;

export default function App() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [selectedApp, setSelectedApp] = useState<AppInfo | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installBaseUrl, setInstallBaseUrl] = useState<string | null>(null);
  const [behindProxy, setBehindProxy] = useState(false);
  const lastClickRef = useRef(0);

  const throttleClick = (fn: () => void) => {
    const now = Date.now();
    if (now - lastClickRef.current < CLICK_THROTTLE_MS) return;
    lastClickRef.current = now;
    fn();
  };

  const [newAppName, setNewAppName] = useState('');
  const [newBundleId, setNewBundleId] = useState('');
  const [newIcon, setNewIcon] = useState<File | null>(null);
  const [newVersion, setNewVersion] = useState('');
  const [newBuild, setNewBuild] = useState('');
  const [newBuildType, setNewBuildType] = useState<'Debug' | 'Release'>('Debug');
  const [newNotes, setNewNotes] = useState('');
  const [newIpa, setNewIpa] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);   // 0-100
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<AppInfo | null>(null);
  const [deletePasscode, setDeletePasscode] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => { fetchApps(); }, []);

  useEffect(() => {
    apiFetch('/api/base-url')
      .then(r => r.json())
      .then((d: { baseUrl: string; behindProxy: boolean }) => {
        setInstallBaseUrl(d.baseUrl);
        setBehindProxy(d.behindProxy);
      })
      .catch(() => setInstallBaseUrl(null));
  }, []);

  const fetchApps = async () => {
    try {
      const res = await apiFetch('/api/apps');
      setApps(await res.json());
    } catch (err) {
      console.error('Failed to fetch apps', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAppDetails = async (id: number) => {
    try {
      const res = await apiFetch(`/api/apps/${id}`);
      setSelectedApp(await res.json());
    } catch (err) {
      console.error('Failed to fetch app details', err);
    }
  };

  const handleCreateApp = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastClickRef.current < CLICK_THROTTLE_MS) return;
    lastClickRef.current = now;

    const fd = new FormData();
    fd.append('name', newAppName);
    fd.append('bundle_id', newBundleId);
    if (newIcon) fd.append('icon', newIcon);

    try {
      const res = await apiFetch('/api/apps', { method: 'POST', body: fd });
      if (res.ok) {
        setIsCreateModalOpen(false);
        setNewAppName(''); setNewBundleId(''); setNewIcon(null);
        fetchApps();
      }
    } catch (err) { console.error('Failed to create app', err); }
  };

  const uploadIpa = (
    file: File,
    appId: number,
    versionNumber: string,
    buildNumber: string,
    buildType: 'Debug' | 'Release',
    notes: string,
  ): Promise<void> => new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('ipa', file, file.name);
    fd.append('app_id', String(appId));
    fd.append('version_number', versionNumber);
    fd.append('build_number', buildNumber);
    fd.append('build_type', buildType);
    fd.append('notes', notes);

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploadProgress(100);
        resolve();
      } else {
        const err = JSON.parse(xhr.responseText || '{}');
        reject(new Error(err.error || 'Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.open('POST', '/api/upload/ipa');
    xhr.send(fd);
  });

  const handleUploadVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedApp || !newIpa) return;
    const now = Date.now();
    if (now - lastClickRef.current < CLICK_THROTTLE_MS) return;
    lastClickRef.current = now;

    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    try {
      await uploadIpa(newIpa, selectedApp.id, newVersion, newBuild, newBuildType, newNotes);
      setIsUploadModalOpen(false);
      setNewVersion(''); setNewBuild(''); setNewBuildType('Debug'); setNewNotes(''); setNewIpa(null);
      setUploadProgress(0);
      fetchAppDetails(selectedApp.id);
    } catch (err: any) {
      console.error('Failed to upload version', err);
      setUploadError(err.message || '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const res = await apiFetch(`/api/apps/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: deletePasscode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '删除失败');
      setDeleteTarget(null);
      setDeletePasscode('');
      fetchApps();
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  const canInstallFromPhone = Boolean(installBaseUrl && !installBaseUrl.includes('localhost'));
  // 证书横幅仅在本地自签名模式下显示（反代模式使用真实 CA 证书，无需手动信任）
  const showCertBanner = !behindProxy && canInstallFromPhone;
  const getInstallUrl = (versionId: number) => {
    const base = canInstallFromPhone ? installBaseUrl! : window.location.origin;
    return `itms-services://?action=download-manifest&url=${encodeURIComponent(`${base}/api/manifest/${versionId}`)}`;
  };

  /* ── 共用样式 ── */
  const cyberInput = [
    'w-full px-4 py-2.5 bg-[#080808] border border-[rgba(0,255,255,0.25)]',
    'text-[#E2E8F0] font-mono text-sm placeholder:text-white/40',
    'focus:border-[#00FFFF] focus:outline-none focus:ring-1 focus:ring-[#00FFFF]/30',
    'transition-all duration-200',
  ].join(' ');
  const cyberLabel = 'block text-[10px] font-mono font-semibold text-[#00FFFF]/70 mb-1.5 uppercase tracking-[0.15em]';

  /* ── 加载画面 ── */
  if (loading) {
    return (
      <div className="min-h-screen bg-[#080808] cyber-grid-bg flex flex-col items-center justify-center gap-4">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 border-2 border-[#00FFFF]/20 rotate-45" />
          <div className="absolute inset-1 border-2 border-[#00FFFF]/40 rotate-[30deg] animate-spin" style={{ animationDuration: '1.5s' }} />
          <div className="absolute inset-2 border-2 border-[#00FFFF] rotate-12" />
        </div>
        <p className="text-[#00FFFF]/60 font-mono text-xs uppercase tracking-widest animate-pulse">
          系统加载中...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080808] cyber-grid-bg text-[#E2E8F0]">

      {/* ── 顶部导航栏 ── */}
      <header className="sticky top-0 z-40 bg-[#080808]/95 border-b border-[rgba(0,255,255,0.2)] backdrop-blur-sm">
        <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-[#00FFFF] to-transparent opacity-60" />
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">

          <div className="flex items-center gap-3">
            {selectedApp ? (
              <button
                onClick={() => throttleClick(() => setSelectedApp(null))}
                className="p-1.5 border border-[rgba(0,255,255,0.25)] text-[#00FFFF]/70 hover:text-[#00FFFF] hover:border-[#00FFFF] transition-all duration-200 cursor-pointer"
                aria-label="返回"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            ) : (
              <div className="flex items-center justify-center w-8 h-8 border border-[#00FFFF]/40 bg-[#00FFFF]/5">
                <Zap className="w-4 h-4 text-[#00FFFF]" style={{ filter: 'drop-shadow(0 0 4px #00FFFF)' }} />
              </div>
            )}
            <div>
              <h1 className="text-sm font-mono font-bold tracking-[0.2em] neon-cyan cyber-flicker">
                {selectedApp ? selectedApp.name : 'iOS 安装包分发'}
              </h1>
              {!selectedApp && (
                <p className="text-[10px] font-mono text-[#FFFFFF] tracking-widest">作者：汪继红</p>
              )}
            </div>
          </div>

          {!selectedApp && (
            <CyberButton variant="cyan" onClick={() => throttleClick(() => setIsCreateModalOpen(true))}>
              <Plus className="w-3.5 h-3.5" />
              新建应用
            </CyberButton>
          )}
          {selectedApp && (
            <CyberButton variant="cyan" onClick={() => throttleClick(() => setIsUploadModalOpen(true))}>
              <Upload className="w-3.5 h-3.5" />
              上传版本
            </CyberButton>
          )}
        </div>
      </header>

      {/* ── 主内容区 ── */}
      <main className="max-w-7xl mx-auto px-6 py-8">

        {/* ── 应用列表 ── */}
        {!selectedApp && (
          <>
            {/* 证书信任提示横幅（仅本地自签名模式显示） */}
            {showCertBanner && (
              <CyberCard className="p-4 mb-6 border-[rgba(255,255,0,0.4)] hover:border-[rgba(255,255,0,0.7)] hover:shadow-[0_0_16px_rgba(255,255,0,0.15)]" hover>
                <div className="flex gap-4 items-start">
                  <Shield className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" style={{ filter: 'drop-shadow(0 0 4px rgba(255,255,0,0.5))' }} />
                  <div className="flex-1 space-y-2">
                    <p className="font-mono text-sm font-bold text-yellow-500 uppercase tracking-widest">// 内网直连模式 : 需信任证书</p>
                    <p className="text-[11px] font-mono text-[#E2E8F0]/80">
                      iOS 必须通过 HTTPS 安装应用。当前使用内网自签名 HTTPS，<span className="text-yellow-400 font-bold">新手机首次测试前必须安装并信任证书：</span>
                    </p>
                    <div className="flex flex-col md:flex-row gap-3 items-center">
                      <a href="/api/install-cert" className="inline-flex items-center justify-center gap-2 px-4 py-2 font-mono text-xs tracking-widest border border-yellow-500/60 text-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20 transition-all duration-200 cursor-pointer">
                        <Upload className="w-3.5 h-3.5 rotate-180" />
                        下载证书
                      </a>
                      <p className="text-[10px] font-mono text-white/50 leading-relaxed md:max-w-xl">
                        1. 手机连同 WiFi，Safari 打开本页点击「下载证书」<br/>
                        2. 手机 <span className="text-white/80">设置 → 已下载描述文件</span>，点击安装<br/>
                        3. 手机 <span className="text-white/80">设置 → 通用 → 关于本机 → 证书信任设置</span>，开启开关
                      </p>
                    </div>
                  </div>
                </div>
              </CyberCard>
            )}

            <div className="flex items-center gap-3 mb-6">
              <span className="text-[10px] font-mono text-[#00FFFF]/50 uppercase tracking-[0.2em]">
                // 应用列表
              </span>
              <div className="flex-1 h-px bg-gradient-to-r from-[#00FFFF]/20 to-transparent" />
              <span className="text-[10px] font-mono text-white/50">[{apps.length} 个应用]</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {apps.map((app) => (
                <motion.div
                  layoutId={`app-${app.id}`}
                  key={app.id}
                  onClick={() => throttleClick(() => fetchAppDetails(app.id))}
                >
                  <CyberCard className="p-5 cursor-pointer group">
                    <div className="flex items-start gap-4">
                      <div className="relative flex-shrink-0 w-14 h-14 border border-[rgba(0,255,255,0.2)] bg-[#080808] overflow-hidden">
                        {app.icon_url ? (
                          <img src={app.icon_url} alt={app.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[#00FFFF]/30">
                            <Package className="w-6 h-6" />
                          </div>
                        )}
                        <CyberCorners color="#00FFFF" size="sm" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-mono font-bold truncate text-[#E2E8F0] group-hover:text-[#00FFFF] transition-colors duration-200 uppercase tracking-wide">
                          {app.name}
                        </h3>
                        <p className="text-[11px] font-mono text-white/50 truncate mt-0.5">{app.bundle_id}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono border border-[#00FFFF]/40 text-[#00FFFF] bg-[#00FFFF]/5 uppercase tracking-wide">
                            {app.latest_version ? `v${app.latest_version}` : '暂无版本'}
                          </span>
                          {app.last_upload_at && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-white/50">
                              <Clock className="w-2.5 h-2.5" />
                              {new Date(app.last_upload_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col items-center gap-2 flex-shrink-0">
                        <ChevronRight className="w-4 h-4 text-white/40 group-hover:text-[#00FFFF] transition-colors duration-200" />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(app);
                            setDeletePasscode('');
                            setDeleteError(null);
                          }}
                          className="p-1 text-white/20 hover:text-[#FF4D4D] hover:drop-shadow-[0_0_4px_rgba(255,77,77,0.8)] transition-all duration-200 cursor-pointer"
                          aria-label="删除应用"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </CyberCard>
                </motion.div>
              ))}

              {apps.length === 0 && (
                <div className="col-span-full">
                  <CyberCard className="py-16 text-center" hover={false}>
                    <Package className="w-10 h-10 text-[#00FFFF]/20 mx-auto mb-3" />
                    <p className="text-[11px] font-mono text-white/60 uppercase tracking-widest">暂无记录</p>
                    <p className="text-[10px] font-mono text-white/40 mt-1">创建第一个应用开始分发</p>
                  </CyberCard>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── 应用详情 ── */}
        {selectedApp && (
          <div className="space-y-6">

            {/* 应用信息头 */}
            <CyberCard className="p-6 flex flex-col md:flex-row gap-6 items-center md:items-start text-center md:text-left">
              <div className="relative flex-shrink-0 w-24 h-24 border border-[rgba(0,255,255,0.2)] bg-[#080808] overflow-hidden">
                {selectedApp.icon_url ? (
                  <img src={selectedApp.icon_url} alt={selectedApp.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[#00FFFF]/20">
                    <Package className="w-10 h-10" />
                  </div>
                )}
                <CyberCorners color="#00FFFF" />
              </div>
              <div className="flex-1">
                <span className="text-[10px] font-mono text-[#00FFFF]/50 uppercase tracking-widest">// 目标锁定</span>
                <h2 className="text-2xl font-mono font-bold tracking-wider uppercase text-[#00FFFF] cyber-flicker mt-1" style={{ textShadow: '0 0 8px rgba(0,255,255,0.6)' }}>
                  {selectedApp.name}
                </h2>
                <p className="text-sm font-mono text-white/50 mt-1">{selectedApp.bundle_id}</p>
              </div>
            </CyberCard>

            {/* 发布日志标题栏 */}
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-[#00FFFF]/50 uppercase tracking-[0.2em]">// 发布日志</span>
              <div className="flex-1 h-px bg-gradient-to-r from-[#00FFFF]/20 to-transparent" />
            </div>

            {/* localhost 安装提示 */}
            {!canInstallFromPhone && (
              <CyberCard className="p-4" hover={false}>
                <div className="flex gap-3">
                  <Info className="w-4 h-4 text-[#00FFFF] flex-shrink-0 mt-0.5" />
                  <div className="text-[11px] font-mono text-[#E2E8F0]/80 space-y-2">
                    <p className="font-bold text-[#00FFFF] uppercase tracking-wide">// 安装受阻 — 检测到本地地址</p>
                    <p>在本机根目录创建 <code className="bg-[#00FFFF]/10 border border-[#00FFFF]/30 px-1 text-[#00FFFF]">.env</code> 文件，填入：</p>
                    <code className="block bg-[#080808] border border-[rgba(0,255,255,0.2)] px-3 py-1.5 text-[#E2E8F0]/70 break-all">
                      APP_URL=https://你的电脑IP:3000
                    </code>
                    <p className="text-white/50">运行 <code className="text-[#00FFFF]/70">ifconfig</code>（Mac）或 <code className="text-[#00FFFF]/70">ipconfig</code>（Win）查看 IP，保存 .env 后重启 <code className="text-[#00FFFF]/70">npm run dev</code> 并刷新。</p>
                  </div>
                </div>
              </CyberCard>
            )}

            {/* 版本卡片列表 */}
            <div className="space-y-4">
              {selectedApp.versions?.map((version) => (
                <CyberCard key={version.id} className="p-5 flex flex-col md:flex-row gap-5 items-center">
                  {/* 二维码 */}
                  <div className="relative flex-shrink-0 p-3 border border-[rgba(0,255,255,0.2)] bg-[#080808]">
                    {canInstallFromPhone ? (
                      <QRCodeSVG
                        value={getInstallUrl(version.id)}
                        size={110}
                        bgColor="#080808"
                        fgColor="#00FFFF"
                      />
                    ) : (
                      <div className="w-[110px] h-[110px] flex flex-col items-center justify-center text-white/40 text-[10px] font-mono text-center gap-1">
                        <QrCode className="w-6 h-6 opacity-30" />
                        <span className="uppercase tracking-wide">需配置地址</span>
                      </div>
                    )}
                    <CyberCorners color="#00FFFF" size="sm" />
                  </div>

                  {/* 版本信息 */}
                  <div className="flex-1 min-w-0 text-center md:text-left">
                    <div className="flex flex-col md:flex-row md:items-center gap-2 mb-2">
                      <span className="text-lg font-mono font-bold text-[#00FFFF] uppercase" style={{ textShadow: '0 0 6px rgba(0,255,255,0.5)' }}>
                        v{version.version_number}
                      </span>
                      {version.build_number && (
                        <span className="text-[11px] font-mono text-white/50 border border-[rgba(0,255,255,0.2)] px-2 py-0.5 inline-block">
                          构建 {version.build_number}
                        </span>
                      )}
                      {/* Debug / Release 色标 */}
                      <span
                        className="text-[10px] font-mono font-bold px-2 py-0.5 border inline-block uppercase tracking-widest"
                        style={version.build_type === 'Release'
                          ? { color: '#FF4D4D', borderColor: 'rgba(255,77,77,0.5)', background: 'rgba(255,77,77,0.08)', textShadow: '0 0 6px rgba(255,77,77,0.5)' }
                          : { color: '#39FF14', borderColor: 'rgba(57,255,20,0.5)', background: 'rgba(57,255,20,0.08)', textShadow: '0 0 6px rgba(57,255,20,0.5)' }
                        }
                      >
                        {version.build_type ?? 'Debug'}
                      </span>
                    </div>
                    <p className="text-[11px] font-mono text-white/50 mb-3 line-clamp-2">
                      {version.notes || '// 暂无更新说明'}
                    </p>
                    <div className="flex flex-wrap items-center gap-4 text-[10px] font-mono text-white/50 justify-center md:justify-start">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(version.created_at.endsWith('Z') ? version.created_at : version.created_at + 'Z').toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                      </span>
                      <span className="flex items-center gap-1 text-[#00FFFF]/50">
                        <Shield className="w-3 h-3" />
                        HTTPS 加密
                      </span>
                    </div>
                  </div>

                  {/* 安装按钮 */}
                  <div className="flex flex-col gap-2 w-full md:w-auto items-center">
                    {canInstallFromPhone ? (
                      <>
                        <a
                          href={getInstallUrl(version.id)}
                          className="flex items-center justify-center gap-2 px-5 py-2.5 font-mono text-sm tracking-widest border border-[#00FFFF]/60 text-[#00FFFF] bg-[#00FFFF]/10 hover:bg-[#00FFFF]/20 hover:border-[#00FFFF] hover:shadow-[0_0_12px_rgba(0,255,255,0.35)] transition-all duration-200 cursor-pointer w-full md:w-auto"
                        >
                          <QrCode className="w-4 h-4" />
                          安装到设备
                        </a>
                        <p className="text-[9px] font-mono text-white/50 uppercase tracking-widest text-center">扫码或点击安装</p>
                        <p className="text-[9px] font-mono text-[#00FFFF]/50 text-center">
                          {behindProxy ? '// HTTPS 已由服务器证书保障' : '// 首次安装：Safari 中先信任证书'}
                        </p>
                      </>
                    ) : (
                      <span className="flex items-center justify-center gap-2 px-5 py-2.5 font-mono text-sm tracking-widest border border-white/20 text-white/40 cursor-not-allowed w-full md:w-auto">
                        <QrCode className="w-4 h-4" />
                        请配置 APP_URL
                      </span>
                    )}
                  </div>
                </CyberCard>
              ))}

              {(!selectedApp.versions || selectedApp.versions.length === 0) && (
                <CyberCard className="py-12 text-center" hover={false}>
                  <Info className="w-8 h-8 text-[#00FFFF]/20 mx-auto mb-2" />
                  <p className="text-[11px] font-mono text-white/60 uppercase tracking-widest">暂无发布版本</p>
                  <p className="text-[10px] font-mono text-white/40 mt-1">上传版本以开始分发</p>
                </CyberCard>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── 新建应用弹窗 ── */}
      <AnimatePresence>
        {isCreateModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => throttleClick(() => setIsCreateModalOpen(false))}
              className="absolute inset-0 bg-black/75"
            />
            <motion.div
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="relative w-full max-w-md"
            >
              <CyberCard className="p-7" hover={false}>
                <div className="mb-6">
                  <p className="text-[10px] font-mono text-[#00FFFF]/50 uppercase tracking-widest mb-1">// 系统</p>
                  <h3 className="text-lg font-mono font-bold uppercase tracking-wider text-[#00FFFF]" style={{ textShadow: '0 0 6px rgba(0,255,255,0.5)' }}>
                    注册新应用
                  </h3>
                </div>

                <form onSubmit={handleCreateApp} className="space-y-4">
                  <div>
                    <label className={cyberLabel}>应用名称</label>
                    <input
                      required type="text" value={newAppName}
                      onChange={e => setNewAppName(e.target.value)}
                      className={cyberInput}
                      placeholder="例：我的应用"
                    />
                  </div>
                  <div>
                    <label className={cyberLabel}>Bundle ID</label>
                    <input
                      required type="text" value={newBundleId}
                      onChange={e => setNewBundleId(e.target.value)}
                      className={cyberInput}
                      placeholder="com.example.app"
                    />
                  </div>
                  <div>
                    <label className={cyberLabel}>应用图标</label>
                    <label className="block cursor-pointer">
                      <div className="relative border border-dashed border-[rgba(0,255,255,0.25)] p-5 text-center hover:border-[#00FFFF]/60 bg-[#080808] transition-all duration-200 group">
                        <Upload className="w-5 h-5 text-[#00FFFF]/30 group-hover:text-[#00FFFF]/60 mx-auto mb-1 transition-colors duration-200" />
                        <span className="text-[11px] font-mono text-white/50 group-hover:text-[#00FFFF]/60 transition-colors duration-200">
                          {newIcon ? newIcon.name : '点击选择'}
                        </span>
                        <CyberCorners color="#00FFFF" size="sm" />
                      </div>
                      <input type="file" accept="image/*" onChange={e => setNewIcon(e.target.files?.[0] || null)} className="hidden" />
                    </label>
                  </div>
                  <div className="pt-3 flex gap-3">
                    <CyberButton variant="ghost" className="flex-1" onClick={() => throttleClick(() => setIsCreateModalOpen(false))}>
                      取消
                    </CyberButton>
                    <CyberButton variant="cyan" type="submit" className="flex-1">
                      <Plus className="w-3.5 h-3.5" />
                      创建
                    </CyberButton>
                  </div>
                </form>
              </CyberCard>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── 上传版本弹窗 ── */}
      <AnimatePresence>
        {isUploadModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { if (!uploading) throttleClick(() => setIsUploadModalOpen(false)); }}
              className="absolute inset-0 bg-black/75"
            />
            <motion.div
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="relative w-full max-w-md"
            >
              <CyberCard className="p-7" hover={false}>
                <div className="mb-6">
                  <p className="text-[10px] font-mono text-[#00FFFF]/50 uppercase tracking-widest mb-1">// 上传</p>
                  <h3 className="text-lg font-mono font-bold uppercase tracking-wider text-[#00FFFF]" style={{ textShadow: '0 0 6px rgba(0,255,255,0.5)' }}>
                    上传新版本
                  </h3>
                </div>

                <form onSubmit={handleUploadVersion} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={cyberLabel}>版本号</label>
                      <input
                        required type="text" value={newVersion}
                        onChange={e => setNewVersion(e.target.value)}
                        className={cyberInput}
                        placeholder="1.0.0"
                        disabled={uploading}
                      />
                    </div>
                    <div>
                      <label className={cyberLabel}>构建号</label>
                      <input
                        type="text" value={newBuild}
                        onChange={e => setNewBuild(e.target.value)}
                        className={cyberInput}
                        placeholder="101"
                        disabled={uploading}
                      />
                    </div>
                  </div>

                  {/* Debug / Release 切换 */}
                  <div>
                    <label className={cyberLabel}>构建模式</label>
                    <div className="flex gap-3">
                      {(['Debug', 'Release'] as const).map(type => {
                        const isDebug = type === 'Debug';
                        const active = newBuildType === type;
                        const activeStyle = isDebug
                          ? 'border-[#39FF14] text-[#39FF14] bg-[rgba(57,255,20,0.1)] shadow-[0_0_10px_rgba(57,255,20,0.3)]'
                          : 'border-[#FF4D4D] text-[#FF4D4D] bg-[rgba(255,77,77,0.1)] shadow-[0_0_10px_rgba(255,77,77,0.3)]';
                        const inactiveStyle = 'border-[rgba(0,255,255,0.2)] text-white/40 bg-transparent';
                        return (
                          <button
                            key={type}
                            type="button"
                            disabled={uploading}
                            onClick={() => setNewBuildType(type)}
                            className={`flex-1 py-2 font-mono text-sm font-bold uppercase tracking-widest border transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${active ? activeStyle : inactiveStyle}`}
                          >
                            {type}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label className={cyberLabel}>更新说明</label>
                    <textarea
                      value={newNotes}
                      onChange={e => setNewNotes(e.target.value)}
                      className={cn(cyberInput, 'resize-none h-20')}
                      placeholder="// 更新内容..."
                      disabled={uploading}
                    />
                  </div>
                  <div>
                    <label className={cyberLabel}>IPA 文件</label>
                    <label className={cn('block', uploading && 'pointer-events-none opacity-50')}>
                      <div className="relative border border-dashed border-[rgba(0,255,255,0.25)] p-6 text-center hover:border-[#00FFFF]/60 bg-[#080808] transition-all duration-200 group cursor-pointer">
                        <Package className="w-6 h-6 text-[#00FFFF]/30 group-hover:text-[#00FFFF]/60 mx-auto mb-1.5 transition-colors duration-200" />
                        <span className="text-[11px] font-mono text-white/50 group-hover:text-[#00FFFF]/60 transition-colors duration-200 block">
                          {newIpa ? newIpa.name : '点击选择 IPA'}
                        </span>
                        {newIpa && (
                          <span className="text-[10px] font-mono text-white/30 mt-0.5 block">
                            {(newIpa.size / 1024 / 1024).toFixed(1)} MB
                          </span>
                        )}
                        <CyberCorners color="#00FFFF" size="sm" />
                      </div>
                      <input required type="file" accept=".ipa" onChange={e => { setNewIpa(e.target.files?.[0] || null); setUploadError(null); }} className="hidden" disabled={uploading} />
                    </label>
                  </div>

                  {/* 进度条（上传中才显示） */}
                  {uploading && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-mono text-[#00FFFF]/70 uppercase tracking-widest animate-pulse">
                          {uploadProgress < 100 ? `// 传输中 ${uploadProgress}%` : '// 合并中...'}
                        </span>
                        <span className="text-[10px] font-mono text-white/40">{uploadProgress}%</span>
                      </div>
                      <div className="relative h-1.5 w-full bg-[#080808] border border-[rgba(0,255,255,0.15)] overflow-hidden">
                        <div
                          className="absolute left-0 top-0 h-full bg-[#00FFFF] transition-all duration-300"
                          style={{ width: `${uploadProgress}%`, boxShadow: '0 0 8px rgba(0,255,255,0.8)' }}
                        />
                      </div>
                    </div>
                  )}

                  {/* 错误信息 */}
                  {uploadError && (
                    <p className="text-[11px] font-mono text-red-400/80 border border-red-400/20 bg-red-400/5 px-3 py-2">
                      ✕ {uploadError}
                    </p>
                  )}

                  <div className="pt-3 flex gap-3">
                    <CyberButton variant="ghost" className="flex-1" onClick={() => { if (!uploading) throttleClick(() => setIsUploadModalOpen(false)); }} disabled={uploading}>
                      取消
                    </CyberButton>
                    <CyberButton variant="cyan" type="submit" disabled={!newIpa || uploading} className="flex-1">
                      <Upload className="w-3.5 h-3.5" />
                      {uploading ? `上传中 ${uploadProgress}%` : '上传'}
                    </CyberButton>
                  </div>
                </form>
              </CyberCard>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── 删除应用弹窗 ── */}
      <AnimatePresence>
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { if (!deleteLoading) { setDeleteTarget(null); setDeletePasscode(''); setDeleteError(null); } }}
              className="absolute inset-0 bg-black/80"
            />
            <motion.div
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="relative w-full max-w-sm"
            >
              <div className="relative bg-[#0D0D0D] border border-[rgba(255,77,77,0.35)] p-7">
                <CyberCorners color="#FF4D4D" />

                <div className="mb-5">
                  <p className="text-[10px] font-mono text-[#FF4D4D]/50 uppercase tracking-widest mb-1">// 危险操作</p>
                  <h3 className="text-lg font-mono font-bold uppercase tracking-wider text-[#FF4D4D]"
                    style={{ textShadow: '0 0 6px rgba(255,77,77,0.5)' }}>
                    删除应用
                  </h3>
                  <p className="text-[11px] font-mono text-white/50 mt-2">
                    将删除 <span className="text-[#FF4D4D]/80 font-bold">{deleteTarget.name}</span> 及其所有版本和 IPA 文件，操作不可撤销。
                  </p>
                </div>

                <form onSubmit={handleDeleteApp} className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-mono font-semibold text-[#FF4D4D]/70 mb-1.5 uppercase tracking-[0.15em]">
                      输入口令确认
                    </label>
                    <input
                      required
                      type="password"
                      autoFocus
                      value={deletePasscode}
                      onChange={e => { setDeletePasscode(e.target.value); setDeleteError(null); }}
                      placeholder="••••"
                      disabled={deleteLoading}
                      className="w-full px-4 py-2.5 bg-[#080808] border border-[rgba(255,77,77,0.25)] text-[#E2E8F0] font-mono text-sm placeholder:text-white/30 focus:border-[#FF4D4D] focus:outline-none focus:ring-1 focus:ring-[#FF4D4D]/30 transition-all duration-200 disabled:opacity-40"
                    />
                  </div>

                  {deleteError && (
                    <p className="text-[11px] font-mono text-[#FF4D4D]/80 border border-[#FF4D4D]/20 bg-[#FF4D4D]/5 px-3 py-2">
                      ✕ {deleteError}
                    </p>
                  )}

                  <div className="pt-2 flex gap-3">
                    <CyberButton
                      variant="ghost"
                      className="flex-1"
                      disabled={deleteLoading}
                      onClick={() => { setDeleteTarget(null); setDeletePasscode(''); setDeleteError(null); }}
                    >
                      取消
                    </CyberButton>
                    <CyberButton variant="red" type="submit" disabled={deleteLoading || !deletePasscode} className="flex-1">
                      <Trash2 className="w-3.5 h-3.5" />
                      {deleteLoading ? '删除中...' : '确认删除'}
                    </CyberButton>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
