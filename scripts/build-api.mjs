/**
 * Bundle the serverless functions in `server/` into `api/`, which is the
 * directory Vercel turns into endpoints.
 *
 * ## Why a build step rather than shipping the TypeScript directly
 *
 * Every relative import in this project carries an explicit `.ts` extension.
 * That is deliberate and load-bearing — the Node evaluation scripts import the
 * same `core/` modules the product runs, and Node's ESM resolver does not guess
 * extensions the way a bundler does. Remove them and the harness that produces
 * the paper's numbers stops resolving.
 *
 * Vercel compiles each function file separately with esbuild and leaves import
 * specifiers untouched, so `nutrition.ts` became `nutrition.js` still asking for
 * `'./_llm.ts'` — a file no longer there. Deploy succeeded; every request to a
 * nutrition or coaching endpoint died with ERR_MODULE_NOT_FOUND.
 *
 * Two obvious fixes were tried and rejected on evidence:
 *
 * - `rewriteRelativeImportExtensions` in tsconfig does exactly the right thing,
 *   and `tsc` honours it. esbuild does not, and esbuild is what Vercel runs.
 * - Writing `.js` in the specifiers satisfies TypeScript and Vercel, and breaks
 *   Node: it does not map a `.js` specifier onto a `.ts` file, so the eval
 *   scripts fail instead.
 *
 * Bundling sidesteps the disagreement rather than picking a side. Each function
 * becomes one self-contained file with no relative imports left to resolve, so
 * there is nothing for the runtime to get wrong.
 *
 * Dependencies stay external: they are installed on the deployment and tracing
 * them is Vercel's job, not this script's.
 */

import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'server');
const outdir = join(root, 'api');

/**
 * Files starting with `_` are shared helpers, not endpoints.
 *
 * Vercel would otherwise publish `/api/_llm` as a route of its own — reachable,
 * exporting no handler, and answering every request with a runtime error.
 */
const entryPoints = readdirSync(source)
  .filter((file) => file.endsWith('.ts') && !file.startsWith('_'))
  .map((file) => join(source, file));

// Cleared first, so a renamed or deleted endpoint cannot linger as a stale
// bundle that keeps answering requests after its source is gone.
rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'info',
});

console.log(`Bundled ${entryPoints.length} endpoints into api/`);
