import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/** Popup build: React + HTML entry -> dist/popup.html + dist/assets/* */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    minify: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: { popup: fileURLToPath(new URL('./popup.html', import.meta.url)) },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
