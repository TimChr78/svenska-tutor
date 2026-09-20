import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
