/**
 * Variants (`actions/app_variants.ts`): a branch kept running as an
 * environment of its own, with values it carries in `variant.json`. Two
 * variants of one app run side by side and only the one carrying
 * `PRINT=true` prints; the board shows each with its values and last
 * output; a variant outlives a reconcile that reaps previews of closed
 * pulls; a reader, an agent and a mirror may change nothing.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { makeMain, registerVariant, retireVariant, setVariantValues, variantBoard } from "../src/actions/app_variants.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { envVariant, envWords, variantEnv } from "../src/apps/data.ts";
import { parseAppHost, resolveAppHostname } from "../src/apps/proxy.ts";
import { parseAppLogin } from "../src/apps/tty.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { checkValue, readVariantValues, parseValueLines, parseVariantFile, readLastOutput, variantFileText } from "../src/apps/variant_file.ts";
import { isSlug, type AppRecord } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { VARIANTS_MAX, labelFor, listVariants } from "../src/core/variants.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";

const DOMAIN = "apps.test";

/** Says whether it prints, and leaves the edition it made for the board. */
const SERVER = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const print = process.env.PRINT ?? "unset";
const voice = process.env.VOICE ?? "plain";
writeFileSync(join(process.env.FORGE_APP_DATA ?? ".", "last-output.json"),
  JSON.stringify({ title: "Edition " + voice + (print === "true" ? " (printed)" : ""), path: "/editions/1" }));
Bun.serve({
  port: Number(process.env.PORT ?? "0"),
  hostname: "127.0.0.1",
  fetch: () => new Response("PRINT=" + print + " VOICE=" + voice),
});
`;

describe("variant names", () => {
  test("the host, the login and the words read a variant back", () => {
    expect(variantEnv("print")).toBe("variant-print");
    expect(envVariant("variant-print")).toBe("print");
    expect(envVariant("pull-3")).toBeUndefined();
    expect(parseAppHost(`show--v-print.${DOMAIN}`, DOMAIN)).toEqual({ slug: "show", env: "variant-print", nested: false });
    expect(parseAppHost(`notes--show--v-print.${DOMAIN}`, DOMAIN)).toEqual({ slug: "show", env: "variant-print", nested: true });
    // Not a label: a slug with a hyphen, as it was.
    expect(parseAppHost(`show--v-pr-nt.${DOMAIN}`, DOMAIN)?.env).toBe("production");
    expect(parseAppHost(`show--v-${"a".repeat(17)}.${DOMAIN}`, DOMAIN)?.env).toBe("production");
    expect(parseAppHost(`show--3.${DOMAIN}`, DOMAIN)?.env).toBe("pull-3");
    expect(envWords("variant-print")).toBe("the print variant");
    expect(parseAppLogin("show--v-print")).toBeUndefined(); // no terminal into a variant yet
  });

  test("a variant-shaped slug is reserved, and a label comes from a branch name", () => {
    expect(isSlug("v-print")).toBe(false);
    expect(isSlug("vprint")).toBe(true);
    expect(labelFor("Feature/Print-On")).toBe("featureprinton");
    expect(labelFor("///")).toBe("variant");
    expect(labelFor("a".repeat(40))).toHaveLength(16);
  });
});

describe("variant.json", () => {
  test("values are plain, named like environment variables, and never the forge's", () => {
    expect(parseVariantFile('{"values":{"PRINT":"true"}}')).toEqual({ ok: true, value: { PRINT: "true" } });
    expect(parseVariantFile("{}")).toEqual({ ok: true, value: {} });
    for (const bad of [
      "nope",
      "[]",
      '{"values":[]}',
      '{"extra":1}',
      '{"values":{"print":"x"}}',
      '{"values":{"PRINT":true}}',
      '{"values":{"PORT":"1"}}',
      '{"values":{"FORGE_TOKEN":"x"}}',
      '{"values":{"A":"line\\nbreak"}}',
      `{"values":{"A":"${"x".repeat(201)}"}}`,
    ])
      expect(parseVariantFile(bad).ok).toBe(false);
    expect(checkValue("PRINT", "false")).toBeUndefined();
  });

  test("typed lines become values, and write back as the same bytes", () => {
    const parsed = parseValueLines("PRINT=true\n\n VOICE = dry \n");
    expect(parsed).toEqual({ ok: true, value: { PRINT: "true", VOICE: "dry" } });
    const text = variantFileText({ VOICE: "dry", PRINT: "true" });
    expect(text).toBe('{\n  "values": {\n    "PRINT": "true",\n    "VOICE": "dry"\n  }\n}\n');
    expect(parseVariantFile(text)).toEqual(parsed);
    expect(parseValueLines("no equals").ok).toBe(false);
    expect(parseValueLines("PORT=1").ok).toBe(false);
  });

  test("a variant.json that is a symlink is not followed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-link-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "forge-elsewhere-"));
    try {
      await Bun.write(join(elsewhere, "host.json"), '{"values":{"STOLEN":"yes"}}');
      await symlink(join(elsewhere, "host.json"), join(dir, "variant.json"));
      expect(readVariantValues(dir)).toEqual({});
      await rm(join(dir, "variant.json"));
      await Bun.write(join(dir, "variant.json"), '{"values":{"OWN":"yes"}}');
      expect(readVariantValues(dir)).toEqual({ OWN: "yes" });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test("the output an app leaves is read as data, bounded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-output-"));
    try {
      expect(readLastOutput(dir)).toBeUndefined();
      await Bun.write(join(dir, "last-output.json"), '{"title":"Edition 4","path":"/editions/4"}');
      expect(readLastOutput(dir)).toEqual({ title: "Edition 4", path: "/editions/4" });
      for (const bad of ['{"title":"x","path":"//evil.test"}', '{"title":"x","path":"javascript:1"}', '{"title":""}', "nope"]) {
        await Bun.write(join(dir, "last-output.json"), bad);
        expect(readLastOutput(dir)).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("variants running", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let record: AppRecord;

  const viaHost = async (host: string): Promise<string> =>
    (await fetch(`${servers.url}/`, { headers: { host } })).text();

  async function until<T>(read: () => T | undefined | Promise<T | undefined>, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      await Bun.sleep(50);
    }
    throw new Error("did not happen in time");
  }

  const settled = (where: (run: Run) => boolean): Promise<Run> =>
    until(() =>
      listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) => where(r) && (r.state === "ok" || r.state === "failed" || r.state === "cancelled"),
      ),
    );

  const env = (name: string): EnvStatus | undefined => runtime.status(record).find((e) => e.env === name);

  const answers = (label: string, includes: string): Promise<string> =>
    until(async () => {
      if (env(variantEnv(label))?.state !== "running") return undefined;
      const text = await viaHost(`show--v-${label}.${DOMAIN}`);
      return text.includes(includes) ? text : undefined;
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-variants-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await createRepo(app, alice, { name: "show", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const c1 = await commitToBranch(app, alice, repo, {
      message: "the paper",
      files: [
        { path: "package.json", content: JSON.stringify({ name: "show", scripts: { start: "bun server.ts" } }) },
        { path: "server.ts", content: SERVER },
      ],
    });
    if (!c1.ok) throw new Error(JSON.stringify(c1.error));
    for (const [branch, files] of [
      ["printing", [{ path: "variant.json", content: variantFileText({ PRINT: "true", VOICE: "dry" }) }]],
      ["plain", [{ path: "variant.json", content: variantFileText({ PRINT: "false", VOICE: "warm" }) }]],
    ] as const) {
      const c = await commitToBranch(app, alice, repo, { branch, base: "main", message: `${branch} voice`, files: [...files] });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
    }
    const enabled = enableApp(app, alice, repo, {});
    if (!enabled.ok) throw new Error(enabled.error);
    record = enabled.value;
    const production = await settled((r) => r.env === "production");
    if (production.state !== "ok") throw new Error(production.summary);
  }, 90_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader, an agent and a missing branch change nothing", async () => {
    const reader = await registerVariant(app, bob, repo, { branch: "printing" });
    expect(reader.ok ? undefined : reader.error).toBe("forbidden");
    const anonymous = await registerVariant(app, undefined, repo, { branch: "printing" });
    expect(anonymous.ok ? undefined : anonymous.error).toBe("unauthorized");
    const made = await createAgent(app, alice, { username: "scout", brief: "I ship." });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    const agent = await registerVariant(app, getUserByName(app.db, "scout")!, repo, { branch: "printing" });
    expect(agent.ok ? undefined : agent.error).toBe("forbidden");
    const missing = await registerVariant(app, alice, repo, { branch: "nope" });
    expect(missing.ok ? undefined : missing.error).toBe("no_branch");
    const main = await registerVariant(app, alice, repo, { branch: "main" });
    expect(main.ok ? undefined : main.error).toBe("default_branch");
    const flag = await registerVariant(app, alice, repo, { branch: "--upload-pack=x" });
    expect(flag.ok ? undefined : flag.error).toBe("no_branch");
    const label = await registerVariant(app, alice, repo, { branch: "printing", label: "Bad Label" });
    expect(label.ok ? undefined : label.error).toBe("invalid_label");
    expect(listVariants(app.db, record.id)).toEqual([]);
    expect(listEvents(app.db, { kind: "app.variant_added" })).toEqual([]);
  });

  test("two variants run side by side and only the one with PRINT=true prints", async () => {
    for (const branch of ["printing", "plain"]) {
      const v = await registerVariant(app, alice, repo, { branch });
      expect(v.ok).toBe(true);
    }
    expect(listEvents(app.db, { kind: "app.variant_added" })).toHaveLength(2);
    expect(await answers("printing", "PRINT=")).toBe("PRINT=true VOICE=dry");
    expect(await answers("plain", "PRINT=")).toBe("PRINT=false VOICE=warm");
    // Production keeps the app's defaults.
    expect(await viaHost(`show.${DOMAIN}`)).toBe("PRINT=unset VOICE=plain");
    const again = await registerVariant(app, alice, repo, { branch: "plain", label: "other" });
    expect(again.ok ? undefined : again.error).toBe("branch_taken");
  });

  test("the board shows each variant with its values, state and last output", async () => {
    await until(async () => {
      const b = await variantBoard(app, repo);
      return b?.cards.every((c) => c.output !== undefined) ? b : undefined;
    });
    const board = (await variantBoard(app, repo))!;
    const printing = board.cards.find((c) => c.label === "printing")!;
    expect(printing.values).toEqual({ PRINT: "true", VOICE: "dry" });
    expect(printing.output?.title).toBe("Edition dry (printed)");
    expect(board.cards.find((c) => c.label === "plain")?.output?.title).toBe("Edition warm");
    expect(board.live).toBeGreaterThanOrEqual(2);

    const response = await fetch(`${servers.url}/alice/show/variants`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Edition dry (printed)");
    expect(text).toContain("PRINT=true");
    expect(text).not.toContain("Make this main"); // a stranger sees no controls
    expect(text).toContain("previews");
  });

  test("setting values commits variant.json to the branch and the variant restarts with it", async () => {
    const denied = await setVariantValues(app, bob, repo, "plain", "PRINT=true");
    expect(denied.ok).toBe(false);
    const bad = await setVariantValues(app, alice, repo, "plain", "PORT=1");
    expect(bad.ok ? undefined : bad.error).toEqual({ kind: "bad_values", message: expect.any(String) });
    const missing = await setVariantValues(app, alice, repo, "ghost", "A=1");
    expect(missing.ok ? undefined : missing.error).toBe("not_a_variant");

    const saved = await setVariantValues(app, alice, repo, "plain", "PRINT=true\nVOICE=warm");
    expect(saved.ok).toBe(true);
    expect(await answers("plain", "PRINT=true")).toBe("PRINT=true VOICE=warm");
    const board = (await variantBoard(app, repo))!;
    expect(board.cards.find((c) => c.label === "plain")?.values).toEqual({ PRINT: "true", VOICE: "warm" });
    expect(listEvents(app.db, { kind: "app.variant_values" })).toHaveLength(1);
  });

  test("a variant is not reaped with the previews of closed pulls", async () => {
    await runtime.reconcileApp(record, repo, "enabled");
    expect(env("variant-printing")).toBeDefined();
    expect(env("variant-plain")).toBeDefined();
    const order = runtime.status(record).map((e) => e.env);
    expect(order[0]).toBe("production");
    expect(order.slice(1).sort()).toEqual(["variant-plain", "variant-printing"]);
  });

  test("make this main opens the pull from the branch, once", async () => {
    const first = await makeMain(app, alice, repo, "printing");
    if (!first.ok) throw new Error(String(first.error));
    expect(first.value.headBranch).toBe("printing");
    expect(first.value.baseBranch).toBe("main");
    const second = await makeMain(app, alice, repo, "printing");
    expect(second.ok && second.value.number).toBe(first.value.number);
    const denied = await makeMain(app, bob, repo, "printing");
    expect(denied.ok).toBe(false);
  });

  test("an app keeps a bounded number of variants", () => {
    expect(VARIANTS_MAX).toBeGreaterThanOrEqual(2);
  });

  test("an app already slugged like a variant label keeps its host", async () => {
    const old = await createRepo(app, alice, { name: "oldy", visibility: "public" });
    if (!old.ok) throw new Error(String(old.error));
    app.db.query("INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES ('legacy-app', ?1, 'v-xx', 'public', 'copy')").run(old.value.id);
    const legacy = resolveAppHostname(app, DOMAIN, `show--v-xx.${DOMAIN}`);
    expect(legacy).not.toBe("unknown");
    expect(legacy && legacy !== "unknown" ? [legacy.app.slug, legacy.env] : undefined).toEqual(["v-xx", "production"]);
    const variant = resolveAppHostname(app, DOMAIN, `show--v-printing.${DOMAIN}`);
    expect(variant && variant !== "unknown" ? [variant.app.slug, variant.env] : undefined).toEqual(["show", "variant-printing"]);
  });

  test("a push to a variant's branch redeploys only for a person who can write, never an agent", async () => {
    const tip = (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), "refs/heads/printing"))!;
    const asked: string[] = [];
    const spy = spyOn(runtime as unknown as { requestDeploy: (...a: unknown[]) => unknown }, "requestDeploy").mockImplementation((...a: unknown[]) => {
      if (String(a[2]).startsWith("variant-")) asked.push(String(a[2]));
      return undefined;
    });
    try {
      const push = (actorId: string | null) =>
        app.bus.append({ kind: "push", repoId: repo.id, ...(actorId === null ? {} : { actorId }), payload: { updates: [{ ref: "refs/heads/printing", newOid: tip }] } });
      const scout = getUserByName(app.db, "scout")!;
      push(scout.id);
      push(bob.id);
      push(null);
      await Bun.sleep(300);
      expect(asked).toEqual([]);
      push(alice.id);
      await until(() => (asked.includes("variant-printing") ? true : undefined), 5_000);
    } finally {
      spy.mockRestore();
    }
  });

  test("retiring stops the environment and keeps the branch", async () => {
    const denied = await retireVariant(app, bob, repo, "plain");
    expect(denied.ok).toBe(false);
    const gone = await retireVariant(app, alice, repo, "plain");
    expect(gone.ok).toBe(true);
    expect(env("variant-plain")).toBeUndefined();
    expect(listVariants(app.db, record.id).map((v) => v.label)).toEqual(["printing"]);
    const again = await retireVariant(app, alice, repo, "plain");
    expect(again.ok ? undefined : again.error).toBe("not_a_variant");
  });
});
