/**
 * A child forge's look of its own app (#11519). A forge whose public address
 * is https marks the grant cookie `Secure`; the look's browser opens the app
 * on the forge's plain-http listener and, like Chrome, keeps no `Secure`
 * cookie set over http. It then arrived without its grant and was sent to
 * sign in on the public host, which a cell cannot reach: an error page. The
 * look's grant link carries the forge's proof, and the cookie it sets stays.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { signGrant } from "../src/apps/proxy.ts";
import { newApp } from "../src/actions/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { lookUrl } from "../src/looks/service.ts";
import { refusal } from "../src/looks/capture.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(60_000);

const dirs: string[] = [];
const stops: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const HOST = "cookiegrant.child.test";

/** Where a browser that keeps no `Secure` cookie from http ends up, given the look's URL. */
async function browse(url: string, port: string): Promise<{ finalHost: string; status: number; location: string | null }> {
  let jar = "";
  let at = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (at.hostname !== HOST) return { finalHost: at.hostname, status: 0, location: null };
    const res = await fetch(`http://127.0.0.1:${port}${at.pathname}${at.search}`, {
      redirect: "manual",
      headers: { host: HOST, accept: "text/html", ...(jar === "" ? {} : { cookie: jar }) },
    });
    for (const line of res.headers.getSetCookie()) {
      if (/;\s*secure\b/i.test(line)) continue; // http: the browser drops it
      jar = line.split(";")[0] ?? "";
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || location === null)
      return { finalHost: at.hostname, status: res.status, location };
    at = new URL(location, at);
  }
  return { finalHost: at.hostname, status: -1, location: null };
}

describe("a look of a private app on a forge whose public address is https", () => {
  test("the grant door keeps the browser on the app's host, and the picture is not refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-look-secure-"));
    dirs.push(dir);
    const child = createApp({ dataDir: dir, port: 0, url: "https://child.test" });
    const cs = await serve(child);
    stops.push(() => cs.stop());
    const made_ = await createUser(child.db, { origin: "seed", trusted: true, username: "olive", email: "olive@x.local", password: "a-long-family-passphrase", adminIfFirst: true });
    if (!made_.ok) throw new Error(made_.error);
    const runtime = new AppsRuntime(child, { domain: "child.test", scheme: "https", publicPort: 443, forgeUrl: "https://child.test", concurrency: 1 });
    await runtime.start();
    stops.push(() => runtime.stop());
    const made = await newApp(child, made_.value, { name: "cookiegrant", visibility: "private" });
    if (!made.ok) throw new Error(made.error);
    const target = { app: made.value.app, env: "production" as const };
    const token = signGrant(child.config.dataDir, target, 60_000, Date.now(), { id: made_.value.id, name: "olive", role: "admin" });

    // The look's own link: the cookie is kept, and the page is the app's.
    const url = lookUrl(child.config.dataDir, HOST, String(cs.port), token, "/");
    const got = await browse(url, String(cs.port));
    expect(got.finalHost).toBe(HOST);
    expect(refusal(HOST, undefined, `http://${HOST}/`)).toBeUndefined();

    // Without the proof (a link anyone could make) the cookie stays Secure,
    // and a browser that drops it is sent to sign in on the public host.
    const bare = `http://${HOST}:${cs.port}/__forge/grant?t=${encodeURIComponent(token)}&to=/`;
    const lost = await browse(bare, String(cs.port));
    expect(lost.finalHost).toBe("child.test");

    // A forged proof is no proof.
    const forged = `${url.replace(/plain=[^&]+/, "plain=forged")}`;
    expect((await browse(forged, String(cs.port))).finalHost).toBe("child.test");
  });
});
