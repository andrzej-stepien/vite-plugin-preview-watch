/**
 * Join the resolved `base` with the client path into the absolute URL the
 * reload client should connect to. `base` ends with `/`, `clientPath` starts
 * with `/`, so we drop the duplicate slash.
 *
 * `/` + `/__preview_watch`   -> `/__preview_watch`
 * `/app/` + `/__preview_watch` -> `/app/__preview_watch`
 */
export function joinClientUrl(base: string, clientPath: string): string {
  return base.replace(/\/+$/, "") + clientPath;
}

/** Client behaviour on a successful rebuild. */
export type ClientMode = "auto" | "manual";

interface ClientBuildState {
  serverId: string;
  revision: number;
  error: string | null;
}

const OVERLAY_STYLE =
  "position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;" +
  "background:rgba(20,20,20,.95);color:#ff5555;" +
  "font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
  "white-space:pre-wrap;overflow:auto;";

const TOAST_STYLE =
  "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
  "padding:10px 14px;background:#1b1b1f;color:#e2e2e6;" +
  "font:13px/1.4 system-ui,sans-serif;border:1px solid #3c3c44;" +
  "border-radius:8px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4);";

// Small "Reload" button pinned to the top-right corner of the error overlay.
// Kept dark and monospace to match the overlay itself.
const RELOAD_BUTTON_STYLE =
  "position:absolute;top:12px;right:12px;padding:4px 10px;" +
  "background:#2a2a2e;color:#e2e2e6;" +
  "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
  "border:1px solid #4a4a52;border-radius:6px;cursor:pointer;";

/**
 * Render the inline script injected into served HTML. It opens an EventSource
 * to the plugin's SSE endpoint and reacts to:
 *
 * - `reload` (successful rebuild): in `auto` mode, full-page reload; in
 *   `manual` mode, clear any error overlay and show a "Rebuilt - click to
 *   reload" toast so in-page state survives until the user opts in;
 * - `build-error`: show a full-screen overlay with the build error (custom
 *   event name so it is not confused with EventSource's built-in `error`
 *   event, which fires on connection drops);
 * - reconnection (an `open` after the connection previously dropped): reload
 *   only when the server instance changed or a build completed while we were
 *   disconnected. This avoids a false reload after a transient SSE/proxy
 *   disconnect. Disabled when `reconnect` is `false`, so a deliberately
 *   restarted preview server does not trigger reloads.
 *
 * The build-error overlay carries a small "Reload" button in its corner
 * (`data-vite-preview-watch-reload`) so the user can force a reload without the
 * DevTools console. The error text itself stays `textContent` (never
 * `innerHTML`) so build output can never inject HTML into the page. EventSource
 * reconnects on its own, so no manual retry logic is needed.
 *
 * @param url       Absolute URL of the SSE endpoint.
 * @param mode      Client behaviour on a successful rebuild.
 * @param reconnect Whether a reconnect with a changed server/build state should
 *                  reload (or toast). Defaults to `true`.
 * @param initialState Build state associated with the served HTML document.
 */
export function renderClientScript(
  url: string,
  mode: ClientMode,
  reconnect = true,
  initialState: ClientBuildState | null = null,
): string {
  return (
    `<script type="module">` +
    `(()=>{` +
    `const s=new EventSource(${JSON.stringify(url)});` +
    `const manual=${JSON.stringify(mode === "manual")};` +
    `const reconnect=${JSON.stringify(reconnect)};` +
    `const initial=${JSON.stringify(initialState)};` +
    `let box,toast,wasOpen=false,pendingReconnect=false,hasReady=initial!==null,serverId=initial?initial.serverId:null,revision=initial?initial.revision:-1;` +
    `const clearBox=()=>{if(box){box.remove();box=null;}};` +
    `const clearToast=()=>{if(toast){toast.remove();toast=null;}};` +
    `const root=()=>document.body||document.documentElement;` +
    `const showToast=()=>{` +
    `if(toast)return;` +
    `toast=document.createElement("div");` +
    `toast.setAttribute("data-vite-preview-watch-toast","");` +
    `toast.style.cssText=${JSON.stringify(TOAST_STYLE)};` +
    `toast.textContent="Rebuilt - click to reload";` +
    `toast.addEventListener("click",()=>location.reload());` +
    `root().appendChild(toast);` +
    `};` +
    `const showError=(msg)=>{` +
    `clearBox();clearToast();` +
    `box=document.createElement("pre");` +
    `box.setAttribute("data-vite-preview-watch-error","");` +
    `box.style.cssText=${JSON.stringify(OVERLAY_STYLE)};` +
    `box.textContent=msg;` +
    `const btn=document.createElement("button");` +
    `btn.setAttribute("data-vite-preview-watch-reload","");` +
    `btn.style.cssText=${JSON.stringify(RELOAD_BUTTON_STYLE)};` +
    `btn.textContent="Reload";` +
    `btn.addEventListener("click",()=>location.reload());` +
    `box.appendChild(btn);` +
    `root().appendChild(box);` +
    `};` +
    `if(initial&&typeof initial.error==="string")showError(initial.error);` +
    `const onFresh=()=>{if(manual){clearBox();showToast();}else{location.reload();}};` +
    `const parseState=(e)=>{` +
    `try{const v=JSON.parse(e.data);` +
    `if(typeof v.serverId==="string"&&Number.isInteger(v.revision))return v;` +
    `}catch(_){}return null;` +
    `};` +
    `s.addEventListener("reload",(e)=>{` +
    `const v=parseState(e);` +
    `if(v){if(v.serverId===serverId&&v.revision<=revision)return;serverId=v.serverId;revision=v.revision;}` +
    `onFresh();` +
    `});` +
    `s.addEventListener("error",()=>{if(!wasOpen)pendingReconnect=true;});` +
    `s.addEventListener("open",()=>{if(wasOpen)pendingReconnect=true;wasOpen=true;});` +
    `s.addEventListener("ready",(e)=>{` +
    `const v=parseState(e);` +
    `if(!v)return;` +
    `const stateChanged=hasReady&&(v.serverId!==serverId||v.revision!==revision);` +
    `const shouldRefresh=stateChanged&&(pendingReconnect?reconnect:true);` +
    `serverId=v.serverId;revision=v.revision;pendingReconnect=false;` +
    `hasReady=true;` +
    `if(typeof v.error==="string")showError(v.error);else if(v.error===null)clearBox();` +
    `if(shouldRefresh)onFresh();` +
    `});` +
    `s.addEventListener("build-error",(e)=>{` +
    `let msg="Build failed";try{msg=JSON.parse(e.data).message||msg;}catch(_){}` +
    `showError(msg);` +
    `});` +
    `})();` +
    `</script>`
  );
}
