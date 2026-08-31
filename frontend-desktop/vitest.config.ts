import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],
  // '@branding' 与 vite.config.ts 保持一致：ChatPanel 引它拿产品名，不配这个别名，
  // 凡是 import 到 ChatPanel 的用例整套都加载不起来（codecopy / usertext 两套一直是灰的）。
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@branding': path.resolve(__dirname, '../electron/branding.json'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
