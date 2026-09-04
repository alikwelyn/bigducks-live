import { defineConfig } from 'vite';

export default defineConfig({
  root: 'apps/activity',
  build: { outDir: '../../dist/activity', emptyOutDir: true },
});
