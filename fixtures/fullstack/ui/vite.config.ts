import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3010,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET || 'http://localhost:5010',
        changeOrigin: true,
      },
    },
  },
});
