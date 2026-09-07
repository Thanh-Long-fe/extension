import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/** MV3 service worker build -> dist/background.js (ES module, declared "type": "module"). */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    sourcemap: false,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('./src/background/service-worker.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
