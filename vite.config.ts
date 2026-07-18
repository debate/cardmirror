import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The dev server (`npm run dev`) serves from `/`, and production builds
// now default to `/` too — the web app lives at the domain root
// (`https://cardmirror.app`, Cloudflare Workers static assets; the old
// GitHub Pages `/cardmirror/` subpath serves only a redirect stub, see
// web-redirect/). Override with `VITE_BASE=/foo/` if deploying under a
// subpath somewhere else.
//
// `@cardcutter/browser` resolves to the separately-versioned, NOT-
// shipped card-cutter package when it's checked out alongside this
// repo. The app imports it dev-only and dynamically (see
// card-cutter-port.ts, `@vite-ignore`d + try/caught), so when the
// sibling is absent the alias just never resolves — harmless.
const cardCutterEntry = path.resolve(__dirname, '../card-cutter/src/browser.ts');
const cardCutterStub = path.resolve(__dirname, 'src/editor/card-cutter-stub.ts');

export default defineConfig(({ command }) => {
  // The card-cutter engine is experimental and NOT shipped: a
  // production build always resolves `@cardcutter/browser` to the
  // in-repo no-op stub, even when the sibling package is checked out.
  // Only the dev server wires the real engine (when present).
  const cardCutterTarget =
    command === 'serve' && existsSync(cardCutterEntry) ? cardCutterEntry : cardCutterStub;

  // The installable-PWA layer (web app manifest + offline service worker) is
  // WEB-ONLY. The Electron renderer reuses THIS build with `--base=./` (see
  // apps/desktop `build:renderer`); a service worker there is unwanted and
  // misbehaves under file://, so detect that relative base and gate the plugin
  // off. PWA is also skipped for the dev server (`serve`) — it's a build-time,
  // production-only concern; test it with `npm run build && npm run preview`.
  const cliBase = (() => {
    const eq = process.argv.find((a) => a.startsWith('--base='));
    if (eq) return eq.slice('--base='.length);
    const i = process.argv.indexOf('--base');
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  const isElectronRenderer = cliBase === './';
  // `NO_PWA=1` builds without the service worker — use it for local in-place
  // iteration so a stale precache doesn't keep serving old bundles.
  const enablePWA =
    command === 'build' && !isElectronRenderer && !process.env['NO_PWA'];

  return {
    base: process.env['VITE_BASE'] ?? '/',
    resolve: { alias: { '@cardcutter/browser': cardCutterTarget } },
    plugins: [
      // Dev-only: loro-crdt's loader statically imports its .wasm as an
      // ES module, which the dev server rejects ("ESM integration
      // proposal for Wasm" unsupported). The PRODUCTION build already
      // resolves that import to a URL-exporting asset module, and the
      // loader's normalizer handles the {default: url} shape by
      // fetch+instantiate — so dev resolves the same import to `?url`.
      ...(command === 'serve'
        ? [
            {
              name: 'cardmirror:loro-wasm-url-dev',
              enforce: 'pre' as const,
              resolveId(source: string) {
                if (source.endsWith('loro_wasm_bg.wasm')) {
                  return (
                    path.resolve(__dirname, 'node_modules/loro-crdt/bundler/loro_wasm_bg.wasm') +
                    '?url'
                  );
                }
                return null;
              },
            },
          ]
        : []),
      ...(enablePWA
        ? [
          VitePWA({
            // `prompt` (not `autoUpdate`): never force-reload a running editor
            // session — a new version activates on the next launch, so unsaved
            // work is never interrupted. `injectRegister: 'auto'` injects the
            // registration into the built HTML (web only); nothing lands in the
            // Electron renderer, which never sees this plugin.
            registerType: 'prompt',
            injectRegister: 'auto',
            includeAssets: ['favicon.png', 'apple-touch-icon.png'],
            manifest: {
              name: 'CardMirror',
              short_name: 'CardMirror',
              description:
                'A debate-card editor that interoperates with Advanced Verbatim — cut, format, and organize evidence offline.',
              theme_color: '#2563eb',
              background_color: '#ffffff',
              display: 'standalone',
              categories: ['productivity', 'education'],
              icons: [
                { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
                {
                  src: 'pwa-maskable-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
            workbox: {
              // The editor bundle is large; raise the precache cap so the main
              // chunk is cached (else the app won't open offline).
              globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2,ttf,json}'],
              maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
              cleanupOutdatedCaches: true,
            },
          }),
          ]
        : []),
    ],
    server: {
      fs: { allow: [path.resolve(__dirname), path.resolve(__dirname, '../card-cutter')] },
    },
    // Second HTML entry: the floating always-on-top timer window
    // (desktop pop-out; timer.html → timer-popout.ts). Tiny by
    // construction — it pulls the timer UI + settings, never the
    // editor. Also lands in the web build as a harmless dead-end
    // page nothing links to.
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          timer: path.resolve(__dirname, 'timer.html'),
        },
      },
    },
    // loro-crdt's wasm loader uses top-level await, which the dev-time
    // dependency pre-bundler (esbuild, pre-es2022 targets) rejects.
    // Excluding the pair serves them as native ESM in dev — modern dev
    // browsers handle TLA fine, and production goes through rollup,
    // which already builds them (into their own lazy chunks).
    optimizeDeps: { exclude: ['loro-crdt', 'loro-prosemirror'] },
  };
});
