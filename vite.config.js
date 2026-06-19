import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages（サブパス配信）向けに base を切り替える。
  // Vercel ではこの環境変数を設定しないので base: '/'（ルート配信）になる。
  base: process.env.GITHUB_PAGES ? '/Quasar_rec/' : '/',
  // localhost が IPv4/IPv6 どちらに解決されても届くよう全インターフェースにバインド。
  // 127.0.0.1 / localhost / ::1 すべてで応答する。
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
}));
