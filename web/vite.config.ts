import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { apiPlugin } from './vite-plugin-api.ts';

// `import.meta.dirname` rather than `__dirname`: Vite's native config loader
// does not provide the CommonJS globals, and warns that relying on them will
// break when it becomes the default.
const here = import.meta.dirname;

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
  plugins: [apiPlugin()],
  server: { port: 5174 },
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
