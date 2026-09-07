import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Content script build.
 * MV3 declarative content scripts CANNOT be ES modules -> must be a single IIFE file.
 * Everything is inlined; no code-splitting, no CSS files (styles are injected from JS).
 */
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
      entry: fileURLToPath(new URL('./src/content/index.ts', import.meta.url)),
      formats: ['iife'],
      name: '__DOM_MODIFIER_CONTENT__',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { extend: true, inlineDynamicImports: true },
    },
  },
});
