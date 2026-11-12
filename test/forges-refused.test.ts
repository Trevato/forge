/** GET /forges/refused (#11586): an admin reads the last 20 refused first asks. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { recordRefusal } from "../src/core/first_ask_refusals.ts";
import { forgesPage } from "../src/web/pages/forges.ts";
import { forgesRefusedPage } from "../src/web/pages/forges-refused.ts";

const fresh = () => createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-refused-")), url: "https://x.test", port: 0 });
const ctxOf = (app: ReturnType<typeof fresh>, user: unknown) => {
  const request = new Request("https://x.test/forges/refused");
  return { app, request, auth: { user }, params: {}, url: new URL(request.url) } as never;
};

describe("GET /forges/refused", () => {
  test("an admin sees the last 20, newest first, with the reason", async () => {
    const app = fresh();
    for (let i = 0; i < 25; i++) recordRefusal(app.db, { actorId: `u${i}`, ask: `ask number ${i}`, words: "Not today." }, Date.now() - (25 - i) * 1000);
    const res = forgesRefusedPage(ctxOf(app, { id: "a", isAdmin: true }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.match(/data-refusal/g)).toHaveLength(20);
    expect(body).toContain("ask number 24");
    expect(body).not.toContain("ask number 4<");
    expect(body.indexOf("ask number 24")).toBeLessThan(body.indexOf("ask number 23"));
    expect(body).toContain("Not today.");
  });
  test("an empty list is one quiet line", async () => {
    const body = await forgesRefusedPage(ctxOf(fresh(), { id: "a", isAdmin: true })).text();
    expect(body).toContain("No first ask has been refused.");
    expect(body).not.toContain("data-refusal");
  });
  test("a non-admin gets exactly what /forges gives", async () => {
    const app = fresh();
    for (const user of [undefined, { id: "b", isAdmin: false }]) {
      const mine = forgesRefusedPage(ctxOf(app, user));
      const theirs = await forgesPage(ctxOf(app, user));
      expect(mine.status).toBe(theirs.status);
      expect(await mine.text()).toBe(await theirs.text());
    }
  });
  test("markup in an ask renders as text", async () => {
    const app = fresh();
    recordRefusal(app.db, { actorId: null, ask: "<script>alert(1)</script>", words: "no" }, Date.now());
    const body = await forgesRefusedPage(ctxOf(app, { id: "a", isAdmin: true })).text();
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  test("no email or claim code appears", async () => {
    const app = fresh();
    recordRefusal(app.db, { actorId: "u1", ask: "build me a site", words: "no" }, Date.now());
    const body = await forgesRefusedPage(ctxOf(app, { id: "a", isAdmin: true, email: "boss@x.test" })).text();
    expect(body).not.toMatch(/@x\.test|claim/i);
  });
});

describe("doors to /forges/refused", () => {
  const link = async (user: unknown) => {
    const { systemPage } = await import("../src/web/pages/system.ts");
    const app = fresh();
    const res = await systemPage(ctxOf(app, user));
    return (await res.text()).includes('href="/forges/refused"');
  };
  test("/system links it for an admin who is a person, not for others", async () => {
    expect(await link({ id: "a", isAdmin: true, kind: "user" })).toBe(true);
    expect(await link({ id: "b", isAdmin: false, kind: "user" })).toBe(false);
    expect(await link({ id: "c", isAdmin: true, kind: "agent" })).toBe(false);
    expect(await link(undefined)).toBe(false);
  });
  test("the terminal lists the same rows for an admin and none for others", async () => {
    const { refusedLines } = await import("../src/tui/screens/refused.ts");
    const app = fresh();
    recordRefusal(app.db, { actorId: "u1", ask: "build\x1b[31m me", words: "Not today." }, Date.now());
    const as = (user: unknown) => refusedLines({ app, user } as never);
    const lines = as({ id: "a", isAdmin: true, kind: "user" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Not today.");
    expect(lines[0]).not.toContain("\x1b");
    expect(as({ id: "b", isAdmin: false })).toEqual([]);
  });
});
