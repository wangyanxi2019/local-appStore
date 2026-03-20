import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // 允许通过 ngrok 等隧道域名访问（否则会报 Blocked request, host not allowed）
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // ngrok 模式下：HMR WebSocket 必须走 ngrok 公网地址（443），否则浏览器无法连接内网 24678 端口
      hmr: process.env.DISABLE_HMR === 'true'
        ? false
        : process.env.NGROK_URL
          ? { host: process.env.NGROK_URL.replace(/^https?:\/\//, ''), port: 443, protocol: 'wss' }
          : true,
    },
  };
});
