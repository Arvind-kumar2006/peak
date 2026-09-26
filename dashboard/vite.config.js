import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard polls the backend every 2s, so the requests must be same-origin
// in development — a cross-origin poll from 5173 to 4000 would trip CORS on
// every tick and, worse, would break the moment we demo on a machine where
// something else owns 4000. Proxying /api keeps the browser on one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // A demo build should be one self-contained bundle with no runtime
    // surprises. No code splitting: there is nothing to split.
    outDir: 'dist',
    sourcemap: false,
  },
});
