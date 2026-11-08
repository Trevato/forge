/**
 * A DevTools connection to one page of a private headless Chromium, shared
 * by the accessibility check and the browser tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STEP_MS = 15000;

/** A DevTools connection to one page of a private headless Chromium. */
export async function withPage<T>(binary: string, use: (send: (method: string, params?: object) => Promise<any>, once: (event: string) => Promise<void>) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), "forge-axe-"));
  const proc = Bun.spawn(
    [binary, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  try {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let said = "";
    let endpoint: string | undefined;
    const deadline = Date.now() + STEP_MS;
    while (!endpoint && Date.now() < deadline) {
      const { done, value } = await Promise.race([reader.read(), Bun.sleep(STEP_MS).then(() => ({ done: true, value: undefined }))]);
      if (done) break;
      said += decoder.decode(value, { stream: true });
      endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(said)?.[1];
    }
    if (!endpoint) throw new Error("chromium did not offer a DevTools endpoint");
    // The rest of what it says is read and dropped, so the pipe never fills.
    (async () => {
      while (!(await reader.read()).done);
    })().catch(() => {});
    const ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not reach DevTools"));
    });
    let id = 0;
    let session: string | undefined;
    const pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
    const waiting = new Map<string, (() => void)[]>();
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.no(new Error(msg.error.message));
        else p?.ok(msg.result);
      } else if (msg.method) for (const f of [...(waiting.get(msg.method) ?? [])]) f();
    };
    const send = (method: string, params: object = {}) =>
      new Promise<any>((ok, no) => {
        const n = ++id;
        const timer = setTimeout(() => {
          if (pending.delete(n)) no(new Error(`${method} timed out`));
        }, STEP_MS);
        pending.set(n, {
          ok: (v) => (clearTimeout(timer), ok(v)),
          no: (e) => (clearTimeout(timer), no(e)),
        });
        ws.send(JSON.stringify({ id: n, method, params, ...(session ? { sessionId: session } : {}) }));
      });
    const once = (event: string) =>
      new Promise<void>((ok, no) => {
        const done = () => {
          clearTimeout(timer);
          waiting.set(event, (waiting.get(event) ?? []).filter((f) => f !== done));
          ok();
        };
        const timer = setTimeout(() => {
          waiting.set(event, (waiting.get(event) ?? []).filter((f) => f !== done));
          no(new Error(`${event} timed out`));
        }, STEP_MS);
        waiting.set(event, [...(waiting.get(event) ?? []), done]);
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    try {
      return await use(send, once);
    } finally {
      ws.close();
    }
  } finally {
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
