import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  resolve: {
    alias: {
      '@shared': new URL('./shared/src', import.meta.url).pathname,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'three-vendor', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
