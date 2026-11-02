/**
 * The forge pill works by keyboard alone (#5877): in a real headless
 * Chromium, on a seeded app page, only key events: Tab reaches the pill,
 * Enter opens the panel and focuses its first link, Tab cycles inside it,
 * Escape closes it and puts focus back on the pill. The shadow root is
 * closed, so focus inside it is read through the devtools protocol.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../src/apps/process.ts";
import { TOOLBAR_ASSET_PATH, TOOLBAR_PATH, toolbarJs, toolbarTag } from "../src/apps/toolbar.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns } from "./helpers/chrome.ts";

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined)
  console.log("SKIPPING: no chromium that starts on this machine, so the pill keyboard test cannot run");

describe.skipIf(chromium === undefined)("the pill by keyboard", () => {
  let server: ReturnType<typeof Bun.serve>;
  let proc: ReturnType<typeof Bun.spawn>;
  let ws: WebSocket;
  let profile: string;
  let nextId = 1;
  const pending = new Map<number, (m: any) => void>();

  const send = (method: string, params: object = {}): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression: string): Promise<any> =>
    (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  const key = async (name: string, code: number, text?: string, modifiers = 0) => {
    const base = { key: name, code: name, windowsVirtualKeyCode: code, modifiers };
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const tab = (shift = false) => key("Tab", 9, undefined, shift ? 8 : 0);

  /** Run `body` (a function source) with `this` the pill's closed shadow root. */
  const inRoot = async (body: string): Promise<string> => {
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
    const find = (n: any): any =>
      n.attributes?.includes("forge-toolbar") ? n : (n.children ?? []).map(find).find(Boolean);
    const host = find(root);
    const { object } = await send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
    const r = await send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () { ${body} }`,
    });
    return r.result.value;
  };
  const inside = () =>
    inRoot(`var a = this.activeElement; return a ? (a.getAttribute("aria-label") || a.textContent) : "";`);
  const expanded = () => inRoot(`return this.querySelector("button").getAttribute("aria-expanded");`);
  const outside = () => evaluate(`document.activeElement.id || document.activeElement.tagName`);

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === TOOLBAR_PATH || url.pathname === TOOLBAR_ASSET_PATH)
          return new Response(toolbarJs, { headers: { "content-type": "text/javascript" } });
        if (url.pathname === "/__forge/notes") return Response.json({ notes: [] });
        if (url.pathname === "/__forge/crew") return Response.json({});
        const tag = toolbarTag(`http://127.0.0.1:${server.port}`, { app: "notes", repo: "me/notes", env: "production" });
        return new Response(
          `<!doctype html><title>notes</title><body><a id="first" href="/a">first</a><a id="last" href="/b">last</a>${tag}</body>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    profile = mkdtempSync(join(tmpdir(), "forge-pill-kbd-"));
    proc = Bun.spawn(
      [
        chromium!, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-background-networking", "--no-first-run", `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
      ],
      { env: childEnv({}), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    let wsUrl = "";
    while (!wsUrl) {
      const { done, value } = await reader.read();
      if (done) throw new Error("chromium exited early");
      buf += new TextDecoder().decode(value, { stream: true });
      wsUrl = buf.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? "";
    }
    reader.cancel().catch(() => {});
    const base = wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
    const list = (await (await fetch(`${base}/json/list`)).json()) as any[];
    ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok());
      ws.addEventListener("error", () => bad(new Error("devtools refused")));
    });
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.id !== undefined) pending.get(m.id)?.(m);
    });
    await send("Page.enable");
    await send("DOM.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    for (let i = 0; i < 200; i++) {
      if ((await evaluate(`document.readyState === "complete" && !!document.getElementById("forge-toolbar")`)) === true) break;
      await Bun.sleep(25);
    }
  }, 30_000);

  afterAll(async () => {
    ws?.close();
    proc?.kill("SIGKILL");
    await proc?.exited.catch(() => {});
    server?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  test("Tab, Enter, Tab, Escape: keys only, focus checked at each step", async () => {
    await evaluate(`document.getElementById("last").focus()`);
    expect(await outside()).toBe("last");

    await tab();
    expect(await outside()).toBe("forge-toolbar");
    expect(await inside()).toBe("notes, production");
    expect(await expanded()).toBe("false");

    await key("Enter", 13, "\r");
    expect(await expanded()).toBe("true");
    expect(await inside()).toBe("Visit it");

    // Tab walks the panel and wraps from the last stop to the first, never out to the page.
    const seen: string[] = [];
    for (let i = 0; i < 40 && seen.filter((s) => s === "Visit it").length < 2; i++) {
      await tab();
      expect(await outside()).toBe("forge-toolbar");
      seen.push(await inside());
    }
    expect(seen).toContain("Close");
    expect(seen.filter((s) => s === "Visit it").length).toBeGreaterThan(1);

    await tab(true);
    expect(await outside()).toBe("forge-toolbar");

    await key("Escape", 27);
    expect(await expanded()).toBe("false");
    expect(await outside()).toBe("forge-toolbar");
    expect(await inside()).toBe("notes, production");
  }, 30_000);

  test("Space opens it too", async () => {
    await evaluate(`document.getElementById("last").focus()`);
    await tab();
    await key(" ", 32, " ");
    expect(await expanded()).toBe("true");
    expect(await inside()).toBe("Visit it");
    await key("Escape", 27);
    expect(await expanded()).toBe("false");
  }, 30_000);
});
