import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { joinClientUrl, renderClientScript } from "../src/client";

interface FakeEventSource {
  emit(type: string, data?: unknown): void;
}

function executeClient(script: string): {
  source: FakeEventSource;
  reloads: () => number;
} {
  let source: FakeEventSource | undefined;
  let reloadCount = 0;

  class TestEventSource implements FakeEventSource {
    private listeners = new Map<string, ((event: { data?: string }) => void)[]>();

    constructor() {
      source = this;
    }

    addEventListener(
      type: string,
      listener: (event: { data?: string }) => void,
    ): void {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    emit(type: string, data?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: data === undefined ? undefined : JSON.stringify(data) });
      }
    }
  }

  const node = () => ({
    remove() {},
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    style: { cssText: "" },
    textContent: "",
  });
  const body = node();
  const code = script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>"));
  vm.runInNewContext(code, {
    EventSource: TestEventSource,
    document: { body, documentElement: body, createElement: node },
    location: { reload: () => reloadCount++ },
  });

  if (!source) throw new Error("client did not create EventSource");
  return { source, reloads: () => reloadCount };
}

describe("joinClientUrl", () => {
  it("joins root base without a double slash", () => {
    expect(joinClientUrl("/", "/__preview_watch")).toBe("/__preview_watch");
  });

  it("joins a non-root base", () => {
    expect(joinClientUrl("/app/", "/__preview_watch")).toBe(
      "/app/__preview_watch",
    );
  });
});

describe("renderClientScript", () => {
  it("embeds the url and reloads on the reload event", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    expect(script).toContain(`new EventSource("/__preview_watch")`);
    expect(script).toContain(`"reload"`);
    expect(script).toContain("location.reload()");
    expect(script.startsWith("<script")).toBe(true);
    expect(script.endsWith("</script>")).toBe(true);
  });

  it("handles a build-error event with a distinct event name", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    expect(script).toContain(`"build-error"`);
    // Build failures use their own event name; EventSource's built-in error
    // event only identifies a failed connection attempt.
    expect(script).toContain(`addEventListener("error"`);
    expect(script).toContain("data-vite-preview-watch-error");
    // Uses textContent (not innerHTML) so build output cannot inject markup.
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
  });

  it("JSON-encodes the url so quotes cannot break out of the string", () => {
    const script = renderClientScript('/a"b', "auto");
    expect(script).toContain('new EventSource("/a\\"b")');
  });

  it("includes manual=false for auto mode", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    expect(script).toContain("manual=false");
  });

  it("includes manual=true for manual mode", () => {
    const script = renderClientScript("/__preview_watch", "manual");
    expect(script).toContain("manual=true");
  });

  it("includes data-vite-preview-watch-toast attribute", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    expect(script).toContain("data-vite-preview-watch-toast");
  });

  it("includes addEventListener for open event", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    expect(script).toContain(`addEventListener("open"`);
    expect(script).toContain(`addEventListener("ready"`);
    expect(script).toContain("pendingReconnect");
  });

  it("compares the injected page state when reconnect happens before ready", () => {
    const script = renderClientScript("/__preview_watch", "auto", true, {
      serverId: "server-1",
      revision: 0,
      error: null,
    });
    const client = executeClient(script);

    client.source.emit("open");
    client.source.emit("open");
    client.source.emit("ready", {
      serverId: "server-1",
      revision: 0,
      error: null,
    });
    expect(client.reloads()).toBe(0);

    client.source.emit("open");
    client.source.emit("ready", {
      serverId: "server-1",
      revision: 1,
      error: null,
    });

    expect(client.reloads()).toBe(1);
  });

  it("does not refresh after a failed first connection when reconnect is disabled", () => {
    const client = executeClient(
      renderClientScript("/__preview_watch", "auto", false, {
        serverId: "server-a",
        revision: 0,
        error: null,
      }),
    );

    // Server A disappears before it can open the EventSource. Server B is the
    // first server to send ready, so this is still a reconnect.
    client.source.emit("error");
    client.source.emit("open");
    client.source.emit("ready", {
      serverId: "server-b",
      revision: 0,
      error: null,
    });

    expect(client.reloads()).toBe(0);
  });

  it("refreshes when a build finishes before the ordinary first connection", () => {
    const client = executeClient(
      renderClientScript("/__preview_watch", "auto", undefined, {
        serverId: "server-1",
        revision: 0,
        error: null,
      }),
    );

    client.source.emit("open");
    client.source.emit("ready", {
      serverId: "server-1",
      revision: 1,
      error: null,
    });

    expect(client.reloads()).toBe(1);
  });

  it("includes a reload button in the error overlay", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    // Marker attribute the button carries.
    expect(script).toContain("data-vite-preview-watch-reload");
    // Created as a button element with a reload click handler.
    expect(script).toContain(`createElement("button")`);
    expect(script).toContain(`btn.addEventListener("click",()=>location.reload())`);
    // Still no innerHTML anywhere (error text stays textContent).
    expect(script).not.toContain("innerHTML");
  });

  it("defaults reconnect to true when omitted", () => {
    const script = renderClientScript("/__preview_watch", "auto");
    expect(script).toContain("reconnect=true");
    // Reconnect is evaluated after the server reports its current state.
    expect(script).toContain("pendingReconnect?reconnect:true");
  });

  it("embeds reconnect=false when disabled", () => {
    const script = renderClientScript("/__preview_watch", "auto", false);
    expect(script).toContain("reconnect=false");
  });

  it("embeds reconnect=true when enabled explicitly", () => {
    const script = renderClientScript("/__preview_watch", "auto", true);
    expect(script).toContain("reconnect=true");
  });
});
