/**
 * The look (docs/APPS.md): a green deploy is pictured at phone and desktop
 * width, once per head, as the owner would see it; the pictures are served
 * with the repository's own read access and shown on the pull, on the
 * studio's ask row and in the app's head; a picture that could not be
 * taken is recorded as such and the page says so; a closed pull's pictures
 * go with its preview. A stand-in capturer drives all of that; a real
 * Chromium, when this machine has one, proves the browser end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp, newApp, openEnvUrl } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { setIssueStateThrough } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { envDataDir, previewEnv } from "../src/apps/data.ts";
import { readGrant } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { looksForEnv, type Look } from "../src/core/looks.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { err, ok } from "../src/kernel/result.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import {
  findChromium,
  takeLook,
  type Capture,
  type LookInput,
} from "../src/looks/capture.ts";
import { startLooks, type LooksHandle } from "../src/looks/service.ts";

setLogLevel("error");

const DOMAIN = "apps.test";
const PASSWORD = "a-good-passphrase";
/** One transparent pixel: enough to be a picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A PNG's width and height, from its IHDR. */
const pngSize = (path: string): [number, number] => {
  const head = readFileSync(path).subarray(0, 24);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
};

describe("the look", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let looks: LooksHandle;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let record: AppRecord;
  let aliceCookie: string;
  let bobCookie: string;

  // The stand-in browser: writes a picture, or falls over, as told.
  let mode: "ok" | "fail" = "ok";
  const calls: LookInput[] = [];
  const fake: Capture = async (input) => {
    calls.push(input);
    if (mode === "fail") return err("the browser fell over");
    writeFileSync(input.out, PNG);
    return ok();
  };

  const web = (path: string, cookie = "") =>
    fetch(`${servers.url}${path}`, {
      headers: cookie === "" ? {} : { cookie },
      redirect: "manual",
    });

  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  async function until<T>(
    read: () => T | undefined,
    timeoutMs = 60_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(100);
    }
    throw new Error("did not happen in time");
  }

  /** The newest run of an environment, once it has settled. */
  const settled = (
    where: (run: Run) => boolean,
    repoId = repo.id,
  ): Promise<Run> =>
    until(() => {
      const run = listRuns(app.db, repoId, { kind: "deploy", limit: 50 }).find(
        where,
      );
      return run && run.state !== "queued" && run.state !== "running"
        ? run
        : undefined;
    });

  /** Both looks of a commit, once they are recorded — pictured or not. */
  const pictured = (env: string, commitOid: string): Promise<Look[]> =>
    until(() => {
      const rows = looksForEnv(app.db, record.id, env).filter(
        (l) => l.commitOid === commitOid,
      );
      return rows.length === 2 ? rows : undefined;
    }, 30_000);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-looks-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    looks = startLooks(app, { localUrl: servers.url, capture: fake });
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    // Private: the pictures are as private as the code, and the grant is
    // the only way in.
    const made = await newApp(app, alice, {
      name: "hello",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
  }, 30_000);

  afterAll(async () => {
    await looks.stop();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  let pull: Pull;
  let first = "";
  let second = "";

  test("a green deploy is pictured at both widths, as the owner, once per head; a newer head replaces", async () => {
    const production = await settled((r) => r.env === "production");
    expect(production.state).toBe("ok");
    const rows = await pictured("production", production.commitOid);
    expect(rows.map((l) => l.kind).sort()).toEqual(["desktop", "phone"]);
    for (const look of rows) {
      expect(look.error).toBeNull();
      expect(look.path).toBe(
        `looks/${record.id}/production/${production.commitOid}-${look.kind}.png`,
      );
      expect(existsSync(join(dataDir, look.path))).toBe(true);
    }
    // The browser was pointed at the grant door on the forge's own port,
    // and the grant names the owner as an admin.
    expect(calls).toHaveLength(2);
    // Taken to one side and moved in whole: nothing half-written lives
    // under the environment, and nothing is left behind on the side.
    for (const call of calls)
      expect(call.out).toContain(join("looks", ".taking"));
    expect(readdirSync(join(dataDir, "looks", ".taking"))).toEqual([]);
    const phone = calls.find((c) => c.width === 390)!;
    expect(phone.height).toBe(844);
    expect(calls.find((c) => c.width === 1280)?.height).toBe(800);
    const url = new URL(phone.url);
    expect(url.host).toBe(`hello.${DOMAIN}:${servers.port}`);
    expect(url.pathname).toBe("/__forge/grant");
    expect(url.searchParams.get("to")).toBe("/");
    const grant = readGrant(dataDir, url.searchParams.get("t") ?? "", {
      app: record,
      env: "production",
    });
    expect(grant?.who).toEqual({ id: alice.id, name: "alice", role: "admin" });

    // A pull's preview, the same way.
    const committed = await commitToBranch(app, alice, repo, {
      branch: "greeting",
      base: repo.defaultBranch,
      message: "Say hello",
      files: [{ path: "GREETING.md", content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    first = committed.value.commitOid;
    const opened = await openPull(app, alice, repo, {
      title: "Say hello",
      baseBranch: repo.defaultBranch,
      headBranch: "greeting",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
    const env = previewEnv(pull.number);
    expect((await settled((r) => r.env === env)).state).toBe("ok");
    expect(await pictured(env, first)).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(new URL(calls[2]!.url).hostname).toBe(
      `hello--${pull.number}.${DOMAIN}`,
    );

    // The same head green again is not pictured again.
    runtime.requestDeploy(record, repo, env, first, "redeploy");
    expect(
      (await settled((r) => r.env === env && r.reason === "redeploy")).state,
    ).toBe("ok");
    await looks.idle();
    expect(calls).toHaveLength(4);
    expect(looksForEnv(app.db, record.id, env)).toHaveLength(2);

    // A newer head is pictured, and the older head's pictures go.
    const again = await commitToBranch(app, alice, repo, {
      branch: "greeting",
      message: "More greeting",
      files: [{ path: "GREETING.md", content: "hi again\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    second = again.value.commitOid;
    expect(
      (await settled((r) => r.env === env && r.commitOid === second)).state,
    ).toBe("ok");
    expect(await pictured(env, second)).toHaveLength(2);
    expect(calls).toHaveLength(6);
    await until(() =>
      looksForEnv(app.db, record.id, env).every((l) => l.commitOid === second)
        ? true
        : undefined,
    );
    expect(existsSync(join(dataDir, rows[0]!.path))).toBe(true);
    expect(
      existsSync(join(dataDir, "looks", record.id, env, `${first}-phone.png`)),
    ).toBe(false);
  }, 120_000);

  test("the pull page shows both pictures; the route serves them cached, and refuses a stranger", async () => {
    const base = `/alice/hello`;
    const env = `pull-${pull.number}`;
    const page = await (
      await web(`${base}/pulls/${pull.number}`, aliceCookie)
    ).text();
    expect(page).toContain("<h2>Look</h2>");
    expect(page).toContain(`src="${base}/looks/${env}/${second}/phone.png"`);
    expect(page).toContain(`src="${base}/looks/${env}/${second}/desktop.png"`);
    expect(page).toContain(second.slice(0, 7));
    expect(page).not.toContain("the head has moved");

    const image = await web(
      `${base}/looks/${env}/${second}/phone.png`,
      aliceCookie,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);

    // A stranger to a private repository gets the one 404; so does anyone
    // asking for a width, a commit or an environment that has no picture.
    expect(
      (await web(`${base}/looks/${env}/${second}/phone.png`, bobCookie)).status,
    ).toBe(404);
    expect((await web(`${base}/looks/${env}/${second}/phone.png`)).status).toBe(
      404,
    );
    expect(
      (await web(`${base}/looks/${env}/${second}/tablet.png`, aliceCookie))
        .status,
    ).toBe(404);
    expect(
      (await web(`${base}/looks/${env}/${first}/phone.png`, aliceCookie))
        .status,
    ).toBe(404);
    expect(
      (await web(`${base}/looks/pull-99/${second}/phone.png`, aliceCookie))
        .status,
    ).toBe(404);
  });

  let unpictured: Pull;

  test("a picture that could not be taken is recorded with its reason, and the page says so", async () => {
    mode = "fail";
    const env = `pull-${pull.number}`;
    const moved = await commitToBranch(app, alice, repo, {
      branch: "greeting",
      message: "Once more",
      files: [{ path: "GREETING.md", content: "hi once more\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const third = moved.value.commitOid;
    expect(
      (await settled((r) => r.env === env && r.commitOid === third)).state,
    ).toBe("ok");
    const rows = await pictured(env, third);
    for (const look of rows) {
      expect(look.error).toBe("the browser fell over");
      expect(look.path).toBe("");
    }
    // The last good pictures stay, and the page says the head has moved
    // and why there is no picture of it.
    const page = await (
      await web(`/alice/hello/pulls/${pull.number}`, aliceCookie)
    ).text();
    expect(page).toContain(`/looks/${env}/${second}/phone.png`);
    expect(page.replace(/\s+/g, " ")).toContain("the head has moved since");
    expect(page).toContain("the browser fell over");
    expect(
      (await web(`/alice/hello/looks/${env}/${third}/phone.png`, aliceCookie))
        .status,
    ).toBe(404);

    // A pull that never had a picture says so, without one.
    const branch = await commitToBranch(app, alice, repo, {
      branch: "second",
      base: repo.defaultBranch,
      message: "Second",
      files: [{ path: "SECOND.md", content: "2\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Second",
      baseBranch: repo.defaultBranch,
      headBranch: "second",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    unpictured = opened.value;
    const env2 = `pull-${unpictured.number}`;
    expect((await settled((r) => r.env === env2)).state).toBe("ok");
    await pictured(env2, branch.value.commitOid);
    const none = await (
      await web(`/alice/hello/pulls/${unpictured.number}`, aliceCookie)
    ).text();
    expect(none).toContain("<h2>Look</h2>");
    expect(none).toContain("No picture of");
    expect(none).toContain("the browser fell over");
    expect(none).not.toContain(`/looks/${env2}/`);
    mode = "ok";
  }, 120_000);

  test("a closed pull's pictures go with its preview", async () => {
    const env = `pull-${unpictured.number}`;
    expect(looksForEnv(app.db, record.id, env).length).toBeGreaterThan(0);
    const closed = await setIssueStateThrough(
      app,
      alice,
      repo,
      unpictured,
      "closed",
    );
    expect(closed.ok).toBe(true);
    expect(looksForEnv(app.db, record.id, env)).toHaveLength(0);
    expect(existsSync(join(dataDir, "looks", record.id, env))).toBe(false);
    const page = await (
      await web(`/alice/hello/pulls/${unpictured.number}`, aliceCookie)
    ).text();
    expect(page).not.toContain("<h2>Look</h2>");
  });

  test("the studio's look ask leads with the phone picture, and the app's head shows production", async () => {
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    const branch = await commitToBranch(app, alice, repo, {
      branch: "ask/a",
      base: repo.defaultBranch,
      message: "Ask a",
      files: [{ path: "a.md", content: "a\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout.value.user, repo, {
      title: "Ask a",
      baseBranch: repo.defaultBranch,
      headBranch: "ask/a",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const ask = opened.value;
    const env = `pull-${ask.number}`;
    expect((await settled((r) => r.env === env)).state).toBe("ok");
    const rows = await pictured(env, branch.value.commitOid);
    expect(rows.every((l) => l.error === null)).toBe(true);

    const studio = `${aliceCookie}; forge_mode=studio`;
    const page = await (await web("/alice/hello", studio)).text();
    expect(page).toContain(`value="look:${ask.id}"`);
    expect(page).toContain(
      `<a class="look-thumb" href="/alice/hello/pulls/${ask.number}"`,
    );
    expect(page).toContain(
      `src="/alice/hello/looks/${env}/${branch.value.commitOid}/phone.png"`,
    );
    const production = looksForEnv(app.db, record.id, "production").find(
      (l) => l.kind === "desktop",
    )!;
    expect(page).toContain(`class="look-now"`);
    expect(page).toContain(
      `src="/alice/hello/looks/production/${production.commitOid}/desktop.png"`,
    );
    const home = await (await web("/", studio)).text();
    expect(home).toContain(`class="look-thumb"`);
  }, 120_000);

  test("memory pressure is what the container truly holds, never its page cache", async () => {
    const { cgroupMemoryPressure, memoryPressure } =
      await import("../src/looks/service.ts");
    // Not a container here: unknown pressure is no pressure.
    expect(
      cgroupMemoryPressure() === undefined || cgroupMemoryPressure()! >= 0,
    ).toBe(true);
    // 3.4 GB by the total, 2 GB of it held: a picture goes ahead under a
    // 0.7 ceiling. The cache is the kernel's to give back.
    const stat = "anon 2000000000\nfile 1400000000\nkernel 1000\n";
    expect(memoryPressure(stat, "4000000000\n", "3400000000\n")).toBeCloseTo(
      0.5,
    );
    // No breakdown to read: the total is what there is.
    expect(memoryPressure("", "4000000000\n", "3400000000\n")).toBeCloseTo(
      0.85,
    );
    expect(memoryPressure(stat, "max\n", "3400000000\n")).toBeUndefined();
  });

  const chromium = findChromium();
  test.skipIf(chromium === undefined)(
    chromium === undefined
      ? "a real capture — skipped: no chromium on this machine (install one, or set FORGE_CHROMIUM)"
      : `a real capture through the grant door, with ${chromium}`,
    async () => {
      // An app that writes down who the forge said was there.
      const made = await createRepo(app, alice, {
        name: "peek",
        visibility: "private",
      });
      if (!made.ok) throw new Error(String(made.error));
      const peek = made.value;
      const seeded = await commitToBranch(app, alice, peek, {
        message: "Start",
        files: [
          {
            path: "package.json",
            content:
              '{"name":"peek","scripts":{"start":"bun run server.ts"}}\n',
          },
          {
            path: "server.ts",
            content: [
              'import { appendFileSync } from "node:fs";',
              "Bun.serve({",
              '  port: Number(process.env.PORT), hostname: "127.0.0.1",',
              "  fetch(request) {",
              '    const who = request.headers.get("x-forge-identity") ?? "nobody";',
              "    appendFileSync(`${process.env.FORGE_APP_DATA}/seen.txt`, `${who}\\n`);",
              '    return new Response(`<!doctype html><h1>peek</h1><p>${who}</p>`, { headers: { "content-type": "text/html" } });',
              "  },",
              "});",
              "",
            ].join("\n"),
          },
        ],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const enabled = enableApp(app, alice, peek, { slug: "peek" });
      if (!enabled.ok) throw new Error(String(enabled.error));
      expect(
        (await settled((r) => r.env === "production", peek.id)).state,
      ).toBe("ok");
      // The very URL the service builds: the grant door, on this listener.
      const door = openEnvUrl(app, alice, peek, "production");
      if (!door.ok) throw new Error(String(door.error));
      const out = join(dataDir, "real-phone.png");
      const taken = await takeLook({
        url: door.value,
        out,
        width: 390,
        height: 844,
        timeoutMs: 30_000,
      });
      expect(taken).toEqual({ ok: true, value: undefined });
      expect(pngSize(out)).toEqual([390, 844]);
      // The browser arrived through the grant: the app was told who it was.
      const seen = readFileSync(
        join(envDataDir(dataDir, enabled.value.id, "production"), "seen.txt"),
        "utf8",
      );
      expect(seen).toContain(`${alice.id}|alice|admin|`);
    },
    120_000,
  );
});
