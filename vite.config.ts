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
    rollupOptions: {
      output: {
        // Three et Rapier changent rarement : les garder dans leurs propres
        // fichiers les met en cache entre deux versions du jeu et les
        // télécharge en parallèle du code de la piste.
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
});
