import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 두 deploy 타깃 지원:
//   - gps.serial.kr/                  (주 도메인, base = '/')
//   - /gps-tracker/app/               (legacy 서브패스, base = '/gps-tracker/app/')
// VITE_BASE / VITE_OUT 환경변수로 빌드별 분리.
export default defineConfig({
  plugins: [react()],
  base:    process.env.VITE_BASE || '/gps-tracker/app/',
  server: {
    port: 8003,
    proxy: {
      // 로컬 dev: api.js 가 '/gps-tracker/api/v1/...' 로 요청 → gps.serial.kr 로 프록시하면서
      // prefix 를 벗겨 '/api/v1/...' (주 도메인 라우팅) 으로 전달.
      '/gps-tracker/api': {
        target: 'https://gps.serial.kr',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/gps-tracker/, ''),
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
