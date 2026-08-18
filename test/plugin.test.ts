import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viteMock = vi.hoisted(() => ({
  watcher: {
    close: vi.fn<() => Promise<void>>(),
    on: vi.fn(),
  },
  build: vi.fn(),
}));

vi.mock("vite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vite")>()),
  build: viteMock.build,
}));

import { previewWatch } from "../src/plugin";

beforeEach(() => {
  viteMock.watcher.close.mockReset();
  viteMock.watcher.close.mockResolvedValue();
  viteMock.watcher.on.mockReset();
  viteMock.build.mockReset();
  viteMock.build.mockResolvedValue(viteMock.watcher);
});

describe("previewWatch (plugin shape)", () => {
  it("returns a named vite plugin", () => {
    const plugin = previewWatch();
    expect(plugin.name).toBe("vite-plugin-preview-watch");
  });

  it("only applies on the serve command", () => {
    expect(previewWatch().apply).toBe("serve");
  });

  it("exposes a configurePreviewServer hook", () => {
    expect(typeof previewWatch().configurePreviewServer).toBe("function");
  });

  it("accepts options without throwing", () => {
    expect(() =>
      previewWatch({ reload: false, clientPath: "/x", logLevel: "silent" }),
    ).not.toThrow();
  });

  it("closes active SSE clients before the Vite 4 HTTP-close fallback waits", async () => {
    const handlers: ((
      req: EventEmitter & { url?: string; headers: Record<string, string> },
      res: EventEmitter & {
        writeHead: (status: number, headers: Record<string, string>) => void;
        write: (chunk: string) => void;
        end: () => void;
      },
      next: () => void,
    ) => void)[] = [];
    let activeResponse: (EventEmitter & { end: () => void }) | undefined;
    let finishHttpClose: (() => void) | undefined;
    const httpServer = new EventEmitter() as EventEmitter & {
      close: (callback: (error?: Error) => void) => void;
    };
    httpServer.close = (callback) => {
      finishHttpClose = () => {
        httpServer.emit("close");
        callback();
      };
      if (!activeResponse) finishHttpClose();
    };
    const server = {
      config: {
        root: "/fixture",
        base: "/",
        mode: "production",
        configFile: undefined,
        appType: "spa",
        build: { outDir: "dist" },
        preview: { headers: {}, cors: false },
      },
      httpServer,
      middlewares: {
        use: vi.fn((handler) => handlers.push(handler)),
      },
    };

    const configurePreviewServer = previewWatch()
      .configurePreviewServer as (server: unknown) => Promise<void>;
    await configurePreviewServer(server);
    const sse = handlers[0];
    const request = new EventEmitter() as EventEmitter & {
      url: string;
      headers: Record<string, string>;
    };
    request.url = "/__preview_watch";
    request.headers = {};
    const response = new EventEmitter() as EventEmitter & {
      writeHead: (status: number, headers: Record<string, string>) => void;
      write: (chunk: string) => void;
      end: () => void;
    };
    response.writeHead = vi.fn();
    response.write = vi.fn();
    response.end = vi.fn(() => {
      activeResponse = undefined;
      finishHttpClose?.();
      request.emit("close");
    });
    activeResponse = response;
    sse(request, response, vi.fn());

    const close = (server as { close?: () => Promise<void> }).close;
    expect(close).toBeTypeOf("function");
    const firstClose = close?.();
    const secondClose = close?.();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();

    expect(response.end).toHaveBeenCalledOnce();
    expect(viteMock.watcher.close).toHaveBeenCalledOnce();
  });
});
