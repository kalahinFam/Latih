import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Serves `server/*.ts` during `vite dev`, so the whole product runs from one
 * command.
 *
 * The sources live in `server/`; `npm run build:api` bundles them into `api/`
 * for deployment. Dev reads the sources directly, so there is no build step
 * between saving a handler and calling it.
 *
 * Without this a teammate would need the Vercel CLI running alongside Vite just
 * to see coaching feedback, and the setup instructions would grow a step that
 * gets skipped — followed by a bug report that the coach "does nothing".
 *
 * Handlers use the Web-standard `Request`/`Response` signature and are exported
 * under the HTTP method they serve, which is what Vercel's Node runtime reads —
 * a default export there is taken as the older `(req, res)` form and its return
 * value thrown away. Matching that here keeps the same file running unmodified
 * in both places. Nothing in this file ships to production.
 */

const API_DIR_FROM_WEB = '../server';

interface ApiHandler {
  (request: Request): Promise<Response> | Response;
}

function loadEnvFile(dir: string): void {
  // Node 20.6+ can read a .env itself, but only via a CLI flag we do not
  // control here — Vite is launched by npm, not by us.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const contents = readFileSync(join(dir, '.env'), 'utf8');
    for (const line of contents.split('\n')) {
      const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] !== undefined) continue;
      let value = (match[2] ?? '').trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      process.env[key] = value;
    }
  } catch {
    // No .env is a normal state: the fast loop works without a key, and the
    // coach endpoint reports the missing key clearly when it is called.
  }
}

export function apiPlugin(): Plugin {
  return {
    name: 'latih-api-dev',
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      const apiDir = resolve(server.config.root, API_DIR_FROM_WEB);
      loadEnvFile(resolve(server.config.root, '..'));

      let routes: string[] = [];
      try {
        routes = readdirSync(apiDir)
          .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
          .map((f) => f.replace(/\.ts$/, ''));
      } catch {
        return;
      }

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const match = routes.find((route) => url.pathname === `/api/${route}`);
        if (!match) return next();

        try {
          // Loaded through Vite so the handler's own TypeScript and imports
          // resolve exactly as they do in the rest of the project.
          const module = (await server.ssrLoadModule(
            pathToFileURL(join(apiDir, `${match}.ts`)).href,
          )) as Record<string, ApiHandler | undefined>;

          const handler = module[(req.method ?? 'GET').toUpperCase()];
          if (typeof handler !== 'function') {
            // Not a 500: an endpoint that serves POST only should say so for a
            // GET, the same as production does, rather than look broken.
            res.statusCode = 405;
            res.end(
              JSON.stringify({
                error: `server/${match}.ts tidak melayani ${req.method}.`,
              }),
            );
            return;
          }

          const body =
            req.method === 'GET' || req.method === 'HEAD'
              ? undefined
              : await new Promise<string>((ok) => {
                  let data = '';
                  req.on('data', (chunk) => (data += chunk));
                  req.on('end', () => ok(data));
                });

          const response = await handler(
            new Request(`http://localhost${req.url}`, {
              method: req.method,
              headers: req.headers as Record<string, string>,
              body,
            }),
          );

          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          // Write raw bytes, never text. `response.text()` decodes the body as
          // UTF-8, which silently replaces every non-ASCII byte with U+FFFD —
          // fine for JSON, and total corruption for any binary body the API
          // returns. Production returns the Response directly and never hit
          // this, so it would only ever have broken in development.
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          // Surface the real error in dev; production goes through the
          // endpoint's own sanitising error handler.
          server.config.logger.error(`[api] ${String(error)}`);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
      });

      server.config.logger.info(
        `  \x1b[32m➜\x1b[0m  \x1b[1mAPI\x1b[0m:     ${routes.map((r) => `/api/${r}`).join(', ')}`,
      );
    },
  };
}
