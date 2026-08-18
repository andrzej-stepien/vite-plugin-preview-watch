import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { previewWatch } from "../src/plugin";

const servers: PreviewServer[] = [];
const temporaryRoots: string[] = [];

async function closePreviewServer(server: PreviewServer): Promise<void> {
  const close = (server as PreviewServer & { close?: () => Promise<void> | void })
    .close;
  if (typeof close === "function") {
    await close.call(server);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await closePreviewServer(server);
    }),
  );
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vite-preview-watch-"));
  temporaryRoots.push(root);
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><html><body><h1>home</h1></body></html>",
  );
  await writeFile(
    join(root, "about.html"),
    "<!doctype html><html><body><h1>about</h1></body></html>",
  );
  await writeFile(
    join(root, "vite.config.mjs"),
    "import { fileURLToPath } from 'node:url';\nconst root = fileURLToPath(new URL('.', import.meta.url));\nexport default { appType: 'mpa', root, build: { rollupOptions: { input: { home: root + 'index.html', about: root + 'about.html' } } } }\n",
  );
  await build({
    root,
    configFile: join(root, "vite.config.mjs"),
    logLevel: "silent",
  });
  return root;
}

function serverUrl(server: PreviewServer): string {
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Preview server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitForHtml(url: string, init?: RequestInit): Promise<Response> {
  let response = await fetch(url, init);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (response.status !== 404) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
    response = await fetch(url, init);
  }
  return response;
}

describe("previewWatch integration", () => {
  it("injects the SSE client into SPA and MPA HTML and preserves Vary headers", async () => {
    const root = await createFixture();
    const server = await preview({
      root,
      configFile: join(root, "vite.config.mjs"),
      plugins: [previewWatch({ reconnect: false })],
      preview: {
        host: "127.0.0.1",
        port: 0,
        cors: { origin: true },
        headers: { Vary: "Accept-Encoding" },
      },
    });
    servers.push(server);

    const origin = "http://preview-test.example";
    const home = await waitForHtml(`${serverUrl(server)}/`, {
      headers: { Origin: origin },
    });
    const homeBody = await home.text();
    expect(home.status).toBe(200);
    expect(homeBody).toContain("new EventSource(\"/__preview_watch\")");
    expect(homeBody).toMatch(
      /const initial=\{"serverId":"[^"]+","revision":\d+,"error":null\}/,
    );
    expect(home.headers.get("access-control-allow-origin")).toBe(origin);
    expect(home.headers.get("vary")).toContain("Accept-Encoding");
    expect(home.headers.get("vary")).toContain("Origin");

    const about = await waitForHtml(`${serverUrl(server)}/about.html`);
    const aboutBody = await about.text();
    expect(about.status).toBe(200);
    expect(aboutBody).toContain("new EventSource(\"/__preview_watch\")");

    const controller = new AbortController();
    const events = await fetch(`${serverUrl(server)}/__preview_watch`, {
      headers: { Origin: origin },
      signal: controller.signal,
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(events.headers.get("access-control-allow-origin")).toBe(origin);
    expect(events.headers.get("vary")).toContain("Accept-Encoding");
    expect(events.headers.get("vary")).toContain("Origin");
    controller.abort();
  }, 30_000);
});
