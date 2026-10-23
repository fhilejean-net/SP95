import { defineConfig } from 'vite';

// GitHub Pages serves project sites under /<repo>/, while local dev and
// previews run at the root. The deploy workflow sets GITHUB_PAGES=true.
export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/SP95/' : '/',
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
});
