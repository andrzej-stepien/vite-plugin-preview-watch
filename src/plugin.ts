import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { build } from "vite";
import type { Plugin, Rollup } from "vite";
import { joinClientUrl, renderClientScript } from "./client";
import { mergeResponseHeaders, resolveCorsHeaders, type PreviewCors } from "./cors";
import { formatBuildError } from "./error";
import { injectSnippet, isSpaAppType, resolveHtmlFile, stripBase } from "./inject";
import { resolveOptions, type PreviewWatchOptions } from "./options";

const PLUGIN_NAME = "vite-plugin-preview-watch";

function createServerId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Vite plugin that adds a watch mode to `vite preview`: it rebuilds the output
 * directory whenever your source changes and full-page reloads any open preview
 * tabs, so the production build you are previewing stays fresh without a manual
 * `vite build` + refresh.
 *
 * The plugin is inert during `vite dev` and `vite build`; all of its behaviour
 * lives in the `configurePreviewServer` hook.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { previewWatch } from "vite-plugin-preview-watch";
 *
 * export default defineConfig({
 *   plugins: [previewWatch()],
 * });
 * ```
 */
export function previewWatch(options: PreviewWatchOptions = {}): Plugin {
  const opts = resolveOptions(options);

  return {
    name: PLUGIN_NAME,
    // Active for `dev` and `preview` (both resolve with command "serve") but
    // excluded from the nested `build()` we spawn below, so there is no
    // recursion and no duplicate work.
    apply: "serve",

    async configurePreviewServer(server) {
      const config = server.config;
      const base = config.base;
      const outDirAbs = resolve(config.root, config.build.outDir);
      // Vite's appType is "spa" | "mpa" | "custom". Only "spa" (and the
      // undefined default, which resolves to "spa") serves an index.html
      // fallback for extensionless routes. "mpa" serves only explicit *.html,
      // and "custom" does not serve HTML at all - Vite leaves it to the app -
      // so we must not apply the SPA fallback there either. Both non-SPA cases
      // are handled the same way: only explicit *.html requests are injected.
      const isSpa = isSpaAppType(config.appType);
      // Configured preview response headers, minus undefined values (setHeader
      // and writeHead reject those).
      const previewHeaders: Record<string, string | number | string[]> = {};
      for (const [name, value] of Object.entries(config.preview.headers ?? {})) {
        if (value !== undefined) previewHeaders[name] = value;
      }

      // ---- background rebuild -------------------------------------------
      // Re-run the production build in watch mode. This writes into the same
      // outDir the preview server serves from, so every source change lands in
      // the served bundle.
      const watcher = (await build({
        root: config.root,
        base,
        mode: config.mode,
        configFile: config.configFile,
        logLevel: opts.logLevel,
        clearScreen: opts.clearScreen,
        build: { watch: opts.watch },
      })) as Rollup.RollupWatcher;

      // ---- reload wiring -------------------------------------------------
      const clients = new Set<ServerResponse>();
      const serverId = createServerId();
      let buildRevision = 0;

      const send = (event: string, data?: unknown): void => {
        const payload = data === undefined ? "{}" : JSON.stringify(data);
        for (const client of clients) {
          client.write(`event: ${event}\ndata: ${payload}\n\n`);
        }
      };

      // Rollup emits END after EVERY cycle, including a failed one (ERROR is
      // followed by END), so END alone must not be treated as success - that
      // would immediately reload away the error overlay and re-serve the stale
      // bundle. Track failures per cycle instead.
      let buildFailed = false;
      let cycleStart = 0;
      let lastError: unknown = null;
      let currentBuildError: string | null = null;
      watcher.on("event", (event) => {
        switch (event.code) {
          case "START":
            buildFailed = false;
            lastError = null;
            cycleStart = Date.now();
            break;
          case "BUNDLE_END":
            // Per rollup docs: close the result so build plugins get their
            // closeBundle hooks promptly instead of at watcher.close().
            void event.result?.close();
            break;
          case "ERROR":
            buildFailed = true;
            lastError = event.error;
            const formattedError = formatBuildError(event.error);
            currentBuildError = opts.overlay ? formattedError : null;
            // ERROR events can also carry a (partial) build result to close.
            void event.result?.close();
            // Keep the preview alive and surface the failure in the browser.
            // Vite still logs the full error to the terminal itself.
            if (opts.reload && opts.overlay) {
              send("build-error", { message: formattedError });
            }
            break;
          case "END":
            // Successful (re)build: reload, which also clears any overlay. In
            // manual mode we still emit "reload" - the client shows a toast
            // instead of reloading, so the decision stays client-side.
            if (opts.reload && !buildFailed) {
              currentBuildError = null;
              buildRevision += 1;
              send("reload", { serverId, revision: buildRevision });
            }
            // Fire the server-side hook after every cycle, regardless of the
            // reload setting. A user exception here must not take down the
            // preview server.
            if (opts.onRebuild) {
              try {
                opts.onRebuild({
                  ok: !buildFailed,
                  error: buildFailed ? lastError : null,
                  durationMs: Date.now() - cycleStart,
                });
              } catch (err) {
                console.error(`[${PLUGIN_NAME}] onRebuild threw:`, err);
              }
            }
            break;
        }
      });

      if (opts.reload) {
        const clientUrl = joinClientUrl(base, opts.clientPath);
        const clientMode = opts.reload === "manual" ? "manual" : "auto";

        // SSE endpoint the injected client subscribes to.
        server.middlewares.use((req, res, next) => {
          const stripped = stripBase(req.url ?? "", base);
          if (stripped === null) return next();
          if (stripped.split("?")[0] !== opts.clientPath) return next();

          // Mirror the preview server's configured headers and CORS here too,
          // with our SSE headers last so they win.
          const corsHeaders = resolveCorsHeaders(
            config.preview.cors as PreviewCors,
            req.headers.origin,
          );
          res.writeHead(200, {
            ...mergeResponseHeaders(previewHeaders, corsHeaders),
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          res.write("retry: 1000\n\n");
          res.write(
            `event: ready\ndata: ${JSON.stringify({ serverId, revision: buildRevision, error: currentBuildError })}\n\n`,
          );
          clients.add(res);

          // Comment pings keep proxies from dropping the idle connection.
          const ping = setInterval(() => res.write(": ping\n\n"), 30000);
          req.on("close", () => {
            clearInterval(ping);
            clients.delete(res);
          });
        });

        // Inject the reload client into served HTML documents. Runs before the
        // internal static file server so it can short-circuit HTML responses.
        server.middlewares.use((req, res, next) => {
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          const stripped = stripBase(req.url ?? "", base);
          if (stripped === null) return next();

          const pathname = stripped.split("?")[0].split("#")[0];
          const htmlFile = resolveHtmlFile(pathname, outDirAbs, isSpa);
          if (!htmlFile) return next();

          let html: string;
          try {
            html = readFileSync(htmlFile, "utf8");
          } catch {
            // Missing file: let the static server produce the real 404.
            return next();
          }

          const snippet = renderClientScript(
            clientUrl,
            clientMode,
            opts.reconnect,
            { serverId, revision: buildRevision, error: currentBuildError },
          );
          const body = injectSnippet(html, snippet);
          res.statusCode = 200;
          // Mirror the preview server's configured response headers and CORS,
          // then set our own content-type/cache last so they win.
          const corsHeaders = resolveCorsHeaders(
            config.preview.cors as PreviewCors,
            req.headers.origin,
          );
          for (const [name, value] of Object.entries(
            mergeResponseHeaders(previewHeaders, corsHeaders),
          )) {
            res.setHeader(name, value);
          }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(req.method === "HEAD" ? undefined : body);
        });
      }

      // ---- teardown ------------------------------------------------------
      let closePromise: Promise<void> | null = null;
      const closeResources = (): Promise<void> => {
        if (closePromise === null) {
          for (const client of clients) client.end();
          clients.clear();
          closePromise = Promise.resolve()
            .then(() => watcher.close())
            .then(() => undefined);
        }
        return closePromise;
      };
      server.httpServer.once("close", () => {
        void closeResources().catch((error) => {
          console.error(`[${PLUGIN_NAME}] failed to close watcher:`, error);
        });
      });

      const closableServer = server as typeof server & {
        close?: () => Promise<void> | void;
      };
      const originalClose = closableServer.close;
      let serverClosePromise: Promise<void> | null = null;
      if (typeof originalClose === "function") {
        const boundClose = originalClose.bind(server);
        closableServer.close = () => {
          serverClosePromise ??= (async () => {
            // End SSE streams before Vite starts closing its HTTP server.
            // Otherwise Node waits for those keep-alive clients forever.
            const resources = closeResources();
            try {
              await boundClose();
            } finally {
              await resources;
            }
          })();
          return serverClosePromise;
        };
      } else {
        closableServer.close = () => {
          serverClosePromise ??= (async () => {
            // Vite 4 has no PreviewServer.close(). Close our long-lived SSE
            // responses first, then wait for the underlying HTTP close.
            const resources = closeResources();
            try {
              await new Promise<void>((resolve, reject) => {
                server.httpServer.close((error) =>
                  error ? reject(error) : resolve(),
                );
              });
            } finally {
              await resources;
            }
          })();
          return serverClosePromise;
        };
      }
    },
  };
}
