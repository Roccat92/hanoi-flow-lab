import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: process.env.BASE ?? '/hanoi-flow-lab/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
} as any);
