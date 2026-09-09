import { defineConfig } from 'vite';

/**
 * The dashboard is aliased onto preact/compat.
 *
 * The operator UI is used on phones on constrained links; preact keeps the
 * runtime at roughly a tenth of React's transfer size while the source stays
 * ordinary React (hooks, JSX, the same component API). If a future feature
 * needs something preact/compat does not cover, dropping these aliases and
 * installing react/react-dom is the whole migration.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    target: 'es2020',
    /**
     * Three entry points, one build.
     *
     * `index.html` is the operator console and storefront — a single-page app
     * that is deliberately not indexed. The two landing pages are ordinary
     * static HTML with no script of their own: a marketing page that needs
     * JavaScript to show its first sentence is a page search engines rank
     * badly and slow networks never finish.
     */
    rollupOptions: {
      input: {
        app: 'index.html',
        landing: 'landing.html',
        landingEn: 'landing-en.html',
      },
    },
    /**
     * Split CSS per entry.
     *
     * With this off, Vite puts the console's stylesheet into every HTML entry —
     * including the landing pages, whose own `details` and `summary` elements
     * then inherited the dashboard's rules and grew a second border. The
     * console still gets one stylesheet, because it is one entry with no
     * dynamic imports; the landing pages get theirs from /landing.css alone.
     */
    cssCodeSplit: true,
    reportCompressedSize: true,
  },
  server: { host: '0.0.0.0', port: 5173 },
});
