import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { apiPlugin } from './vite-plugin-api.ts';

// `import.meta.dirname` rather than `__dirname`: Vite's native config loader
// does not provide the CommonJS globals, and warns that relying on them will
// break when it becomes the default.
const here = import.meta.dirname;

/**
 * Long-lived caching for the inference assets in dev.
 *
 * The service worker cache-firsts `/models/` and `/mediapipe/` in production,
 * but it is not registered in dev (it would fight hot reload), and Vite's dev
 * server sends no cache headers — so every page reload re-downloaded ~16 MB of
 * WASM and model weights and "opening the camera" felt broken.
 *
 * The files are stable: they only change when the MediaPipe dependency or the
 * model is replaced, at which point the path or a cache version is bumped.
 * Immutable is therefore safe, and reloads serve them from the browser cache.
 */
function modelAssetCache(): Plugin {
  return {
    name: 'model-asset-cache',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname.startsWith('/models/') || pathname.startsWith('/mediapipe/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        next();
      });
    },
  };
}

/**
 * Two entry points share one build.
 *
 * `index.html` is the product. `annotate.html` is the internal tool that turns
 * recorded video into labelled keypoint data — it deliberately lives in the
 * same bundle so it imports the *same* `core/` modules and the *same* MediaPipe
 * runtime the product uses. Extraction parity is not a nicety here: if the
 * annotation pipeline computed landmarks even slightly differently from the
 * live app, every accuracy figure in the paper would describe something other
 * than the shipped product.
 */
export default defineConfig({
  plugins: [apiPlugin(), modelAssetCache()],
  server: { 
    port: 5174,
    host: true,
    allowedHosts: true,   // ini perlu diganti di production
  },
  preview: { port: 5174 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        annotate: resolve(here, 'annotate.html'),
      },
    },
  },
});
