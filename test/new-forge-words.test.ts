/**
 * The page where a forge is made, in plain words (#10787): what sits in
 * `<main>` of /forges/new, for a stranger and for the owner, holds none of
 * the words in `helpers/jargon.ts`; and the not-copied promise keeps every item.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { LEFT_BEHIND } from "../src/spawn/plan.ts";
import { plainWords } from "../src/web/pages/new-forge.ts";
import { jargonIn } from "./helpers/jargon.ts";

const mainOf = (html: string) => /<main\b[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";

describe("new forge words", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-new-forge-words-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0, forgeRepo: "alice/forge-code" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error("user");
    cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a visitor's page has no jargon", async () => {
    const main = mainOf(await (await fetch(`${servers.url}/forges/new`)).text());
    expect(main).toContain("Never copied");
    expect(jargonIn(main)).toEqual([]);
  });

  test("the owner's page has no jargon", async () => {
    const main = mainOf(await (await fetch(`${servers.url}/forges/new`, { headers: { cookie } })).text());
    expect(main).toContain("For whom");
    expect(jargonIn(main)).toEqual([]);
  });

  const post = async (form: [string, string][]) =>
    mainOf(
      await (
        await fetch(`${servers.url}/forges/new`, {
          method: "POST",
          headers: { cookie, origin: "https://forge.test" },
          body: new URLSearchParams(form),
          redirect: "manual",
        })
      ).text(),
    );

  test("the owner's refusals about the key, budget and address have no jargon", async () => {
    const cases: [string, [string, string][]][] = [
      ["modelKey", [["modelKey", "x".repeat(5000)], ["budgetUsd", "5"]]],
      ["budgetUsd", [["modelKey", "sk-ant-api03-abcdefghijklmnop"]]],
      ["budgetUsd", [["budgetUsd", "5"]]],
      ["modelEndpoint", [["modelEndpoint", "https://openrouter.ai/api"]]],
      ["modelEndpoint", [["modelKey", "sk-ant-oat01-abcdefghijklmnop"], ["budgetUsd", "5"], ["modelEndpoint", "https://openrouter.ai/api"]]],
    ];
    for (const [field, extra] of cases) {
      const main = await post([["name", "wordy"], ...extra, ["do", "plan"]]);
      expect(main).toContain(`id="f-${field}-err"`);
      expect(jargonIn(main)).toEqual([]);
    }
  });

  test("a plan made with a key names it as the page does", async () => {
    const main = await post([["name", "wordy"], ["modelKey", "sk-ant-api03-abcdefghijklmnop"], ["budgetUsd", "5"], ["do", "plan"]]);
    expect(main).toContain("its own AI account key");
    expect(jargonIn(main)).toEqual([]);
  });

  test("the not-copied list keeps its seven items, and the page words them plainly", () => {
    expect([...LEFT_BEHIND]).toEqual([
      "secrets", "tokens", "SSH keys", "agent credentials", "run ledger", "issues", "user accounts",
    ]);
    expect(LEFT_BEHIND.map(plainWords)).toEqual([
      "secrets", "access passes", "remote-login keys", "the crew's sign-ins", "run ledger", "issues", "user accounts",
    ]);
  });
});
