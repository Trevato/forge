/**
 * The New forge form offers a size (#5680): small is chosen and never
 * recorded, medium or large reaches the plan and the child's parent.json,
 * and an unknown size is a 422 beside the field with the other values kept.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import * as door from "../src/spawn/door.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-new-forge-passphrase";

describe("New forge size", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";

  const post = (form: [string, string][]) =>
    fetch(`${servers.url}/forges/new`, {
      method: "POST",
      headers: { cookie, origin: "https://forge.test" },
      body: new URLSearchParams(form),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-new-forge-size-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!a.ok) throw new Error("user");
    servers = await serve(app);
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the select is there with small chosen", async () => {
    const res = await fetch(`${servers.url}/forges/new`, { headers: { cookie } });
    const html = (await res.text()).replace(/\s+/g, " ");
    expect(html).toMatch(/<select class="input" id="f-size" name="size"\s+aria-describedby="f-size-hint"/);
    expect(html).toMatch(/<option value="small" selected >/);
    expect(html).toMatch(/<option value="medium" >/);
    expect(html).toMatch(/<option value="large" >/);
  });

  test("small sends no size; medium sends it and reaches parent.json", async () => {
    const spy = spyOn(door, "spawnDoor");
    try {
      await post([["name", "tiny"], ["size", "small"], ["do", "plan"]]);
      const small = spy.mock.calls.at(-1)![2];
      expect("size" in small).toBe(false);

      const res = await post([["name", "roomy"], ["size", "medium"], ["do", "spawn"]]);
      expect(res.status).toBe(201);
      expect(spy.mock.calls.at(-1)![2]["size"]).toBe("medium");
      const docs = await Promise.all(
        (await readdir(join(dir, "children"))).map((d) =>
          Bun.file(join(dir, "children", d, "parent.json")).json().catch(() => undefined),
        ),
      );
      expect(docs.find((d) => d?.name === "roomy")?.size).toBe("medium");
    } finally {
      spy.mockRestore();
    }
  });

  test("an unknown size is a 422 with the message and the other values kept", async () => {
    const res = await post([
      ["name", "odd"],
      ["direction", "Keep this text."],
      ["size", "huge"],
      ["do", "plan"],
    ]);
    expect(res.status).toBe(422);
    const html = (await res.text()).replace(/\s+/g, " ");
    expect(html).toContain('<span class="error" id="f-size-err">size must be small, medium or large</span>');
    expect(html).toMatch(/<div class="field" data-invalid>\s*<label for="f-size">/);
    expect(html).toMatch(/id="f-size"\s+name="size"\s+aria-describedby="f-size-hint f-size-err"\s+aria-invalid="true"/);
    expect(html).toContain('value="odd"');
    expect(html).toContain("Keep this text.");
    expect(html).toMatch(/<option value="small" selected >/);
  });
});
