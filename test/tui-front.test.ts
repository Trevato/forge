/**
 * The front page in the terminal: the stranger's list in MCP `front_page`'s
 * order with its score parts; a site admin who is a person pins and hides
 * after a plan; anyone else has neither key; a private app is never listed.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { frontJson, forgetFrontScores } from "../src/actions/front.ts";
import { createRepo } from "../src/actions/repos.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { encodePng } from "../src/design/image/png.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { tool } from "../src/http/mcp/tools/front_page.ts";
import { serve } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const HEAD = "a".repeat(40);
const PNG = Buffer.from(encodePng(1, 1, new Uint8Array([255, 255, 255, 255])));

describe("the front page in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let runtime: AppsRuntime;
  let status: ReturnType<typeof spyOn>;

  function boot(username: string | undefined, agent = false) {
    const terminal = headlessTerminal(140, 32);
    const user =
      username === undefined
        ? undefined
        : { ...getUserByName(forge.db, username)!, ...(agent ? { kind: "agent" as const } : {}) };
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const k of keys) app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const open = async () => {
      app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(app);
      for (const ch of "Front page") app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(app);
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, open, stop: () => app.stop() };
  }

  const make = async (owner: string, name: string, visibility: "public" | "private") => {
    const made = await createRepo(forge, getUserByName(forge.db, owner)!, { name, visibility, description: name });
    if (!made.ok) throw new Error(String(made.error));
    const record = insertApp(forge.db, { repoId: made.value.id, slug: name, access: "public" });
    if (!record.ok) throw new Error(record.error);
    mkdirSync(join(dataDir, "looks", record.value.id), { recursive: true });
    writeFileSync(join(dataDir, "looks", record.value.id, "thumb.png"), PNG);
    recordLook(forge.db, {
      appId: record.value.id,
      env: "production",
      commitOid: HEAD,
      kind: "thumb",
      path: `looks/${record.value.id}/thumb.png`,
    });
    return made.value;
  };

  const mcpOrder = (): string[] => {
    const out = tool.run({ app: forge } as never, getUserByName(forge.db, "alice")!, {}) as never as { value: unknown };
    const v = out.value as { featured: { repo: string } | null; apps: { repo: string }[] };
    return [...(v.featured ? [v.featured.repo] : []), ...v.apps.map((a) => a.repo)];
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-front-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      promote(forge.db, made.value);
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
    status = spyOn(AppsRuntime.prototype, "status").mockImplementation(
      (_r: AppRecord): EnvStatus[] => [{ env: "production", state: "running", commitOid: HEAD } as EnvStatus],
    );
    runtime = new AppsRuntime(forge, {
      domain: "front.test",
      scheme: "http",
      publicPort: 1,
      forgeUrl: "http://localhost:1",
    });
    await make("alice", "one", "public");
    await make("alice", "two", "public");
    await make("bob", "three", "public");
    await make("bob", "secret", "private");
    forgetFrontScores(forge);
  });

  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists the stranger's apps in MCP front_page's order, never a private one", async () => {
    const order = mcpOrder();
    expect(order.length).toBe(3);
    expect(order.some((r) => r.endsWith("/secret"))).toBe(false);
    const t = boot("bob");
    await t.open();
    const text = t.text();
    expect(text).toContain("What a signed-out visitor sees");
    expect(text).toContain("forks 0");
    expect(text).not.toContain("/secret");
    const at = order.map((r) => text.indexOf(r));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    t.stop();
  });

  test("a non-admin has neither key", async () => {
    const stranger = frontJson(forge, undefined);
    const t = boot("bob");
    await t.open();
    const before = t.text();
    await t.press("p");
    expect(t.text()).toBe(before);
    await t.press("h");
    expect(t.text()).toBe(before);
    t.stop();
    // An admin agent is no person: no keys either.
    const a = boot("carol", true);
    await a.open();
    const seen = a.text();
    await a.press("h");
    expect(a.text()).toBe(seen);
    await a.press("p");
    expect(a.text()).toBe(seen);
    a.stop();
    expect(frontJson(forge, undefined)).toEqual(stranger);
  });

  test("signed out, the list is the stranger's and p and h do nothing", async () => {
    const stranger = frontJson(forge, undefined);
    const t = boot(undefined);
    await t.open();
    const before = t.text();
    for (const r of mcpOrder()) expect(before).toContain(r);
    expect(before).not.toContain("/secret");
    expect(before).not.toContain("pin or unpin");
    await t.press("p");
    expect(t.text()).toBe(before);
    await t.press("h");
    expect(t.text()).toBe(before);
    t.stop();
    expect(frontJson(forge, undefined)).toEqual(stranger);
  });

  test("a pin applied in the terminal reaches the web's stranger page", async () => {
    const servers = await serve(forge);
    try {
      const seen = async () =>
        ((await (await fetch(`${servers.url}/api/v1/front`)).json()) as { featured: { repo: string } | null }).featured?.repo;
      const order = mcpOrder();
      const last = order[order.length - 1]!;
      expect(await seen()).not.toBe(last);
      const t = boot("alice");
      await t.open();
      await t.press("j", "j", "p", "left", "enter");
      expect(await seen()).toBe(last);
      const door = await (await fetch(`${servers.url}/`)).text();
      expect(door).toContain(last.split("/")[1]!);
      // Put it back: unpin.
      await t.press("g", "p", "left", "enter");
      t.stop();
    } finally {
      servers.stop();
    }
  });

  test("an admin pins the last app: the plan shows, and after the confirm it is first", async () => {
    const order = mcpOrder();
    const last = order[order.length - 1]!;
    const t = boot("alice");
    await t.open();
    await t.press("j", "j", "p");
    expect(t.text()).toContain(`Pin ${last} first`);
    // Cancel is the default: nothing changed yet.
    await t.press("escape");
    expect(mcpOrder()).toEqual(order);
    await t.press("p", "left", "enter");
    expect(mcpOrder()[0]).toBe(last);
    t.stop();
  });

  test("an admin hides an app: it leaves the list, and shows again from the hidden row", async () => {
    const first = mcpOrder()[0]!;
    const t = boot("alice");
    await t.open();
    await t.press("h", "left", "enter");
    expect(mcpOrder()).not.toContain(first);
    expect(t.text()).toContain("hidden");
    // The hidden row sits at the end; `h` shows it again.
    await t.press("G");
    const rows = mcpOrder().length;
    for (let i = 0; i < rows; i++) await t.press("j");
    await t.press("h", "left", "enter");
    expect(mcpOrder()).toContain(first);
    t.stop();
  });
});
