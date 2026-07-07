import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 두 deploy 타깃 지원:
//   - seriallog.com/gps-tracker/app/  (기존, base = '/gps-tracker/app/')
//   - gps.serial.kr/                  (신규 전용 도메인, base = '/')
// VITE_BASE / VITE_OUT 환경변수로 빌드별 분리.
export default defineConfig({
  plugins: [react()],
  base:    process.env.VITE_BASE || '/gps-tracker/app/',
  server: {
    port: 8003,
    proxy: {
      '/gps-tracker/api': {
        target: 'https://seriallog.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: process.env.VITE_OUT || 'dist',
    rollupOptions: {
      output: {
        // node_modules 통째로 vendor chunk 로 분리 — 앱 배포마다 변하지 않으므로
        // 브라우저 캐시 효과 최대화 (main chunk 만 재다운로드).
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
});
