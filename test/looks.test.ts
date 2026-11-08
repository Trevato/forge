/**
 * The look (docs/APPS.md): a green deploy is pictured at phone, desktop
 * and thumb width, once per head, as the owner would see it; the pictures
 * are served with the repository's own read access and shown on the pull,
 * on the studio's ask row and in the app's head; a picture that could not be
 * taken is recorded as such and the page says so; a closed pull's pictures
 * go with its preview. A stand-in capturer drives all of that; a real
 * Chromium, when this machine has one, proves the browser end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { listEvents } from "../src/core/events.ts";
import { lookSlot, lookUrl, looksForEnv, recordLook, type Look } from "../src/core/looks.ts";
import { decodePng, encodePng } from "../src/design/image/png.ts";
import { setAppMembers } from "../src/core/app_members.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, listRuns, type Run } from "../src/core/runs.ts";
import { readLooks } from "../src/checks/looks.ts";
import { vitalsRows } from "../src/checks/summary.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { err, ok } from "../src/kernel/result.ts";
import { quietLogs } from "./helpers/globals.ts";
import {
  findChromium,
  NO_BROWSER,
  parseRecorded,
  takeLook,
  type Capture,
  type LookInput,
} from "../src/looks/capture.ts";
import { startLooks, type LooksHandle } from "../src/looks/service.ts";

quietLogs();

const DOMAIN = "apps.test";
const PASSWORD = "a-good-passphrase";
/** One transparent pixel: enough to be a picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A blank page at desktop's size, as a browser would picture one. */
const DESKTOP_PNG = Buffer.from(
  encodePng(1280, 800, new Uint8Array(1280 * 800 * 4).fill(255)),
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
  let mode: "ok" | "fail" | "nobrowser" = "ok";
  const calls: LookInput[] = [];
  // The dark pictures, kept apart so what counts the light ones stays true.
  const darkCalls: LookInput[] = [];
  const fake: Capture = async (input) => {
    (input.dark === true ? darkCalls : calls).push(input);
    if (mode === "fail") return err("the browser fell over");
    if (mode === "nobrowser") return err(NO_BROWSER);
    writeFileSync(input.out, input.width === 1280 ? DESKTOP_PNG : PNG);
    // What the page recorded: a slow paint for the phone, a shift for the desktop.
    return ok({
      ...(input.width === 390
        ? { size: { scrollWidth: 390, scrollHeight: 1600, innerWidth: 390, innerHeight: 800 } }
        : {}),
      entries:
        input.width === 390
          ? { lcp: [{ startTime: 3100, size: 10 }] }
          : { layoutShift: [{ startTime: 100, value: 0.3 }] },
    });
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

  /** All three looks of a commit, once they are recorded — pictured or not. */
  const pictured = (env: string, commitOid: string): Promise<Look[]> =>
    until(() => {
      const rows = looksForEnv(app.db, record.id, env).filter(
        (l) => l.commitOid === commitOid,
      );
      return rows.length === 3 ? rows : undefined;
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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

  test("a green deploy is pictured at all three widths, once per head — phone and desktop as the owner, the thumb as a stranger, reduced from the desktop page; a newer head replaces", async () => {
    const production = await settled((r) => r.env === "production");
    expect(production.state).toBe("ok");
    const rows = await pictured("production", production.commitOid);
    expect(rows.map((l) => l.kind).sort()).toEqual([
      "desktop",
      "phone",
      "thumb",
    ]);
    for (const look of rows) {
      expect(look.error).toBeNull();
      expect(look.path).toBe(
        `looks/${record.id}/production/${production.commitOid}-${look.kind}.png`,
      );
      expect(existsSync(join(dataDir, look.path))).toBe(true);
    }
    // The browser was pointed at the grant door on the forge's own port,
    // and the grant names the owner as an admin.
    expect(calls).toHaveLength(3);
    // Taken to one side and moved in whole: nothing half-written lives
    // under the environment, and nothing is left behind on the side.
    for (const call of calls)
      expect(call.out).toContain(join("looks", ".taking"));
    expect(readdirSync(join(dataDir, "looks", ".taking"))).toEqual([]);
    const phone = calls.find((c) => c.width === 390)!;
    expect(phone.height).toBe(844);
    // Desktop and thumb are both taken in desktop's window: a browser does
    // not lay a page out at a tile's size.
    const wide = calls.filter((c) => c.width === 1280);
    expect(wide.map((c) => c.height)).toEqual([800, 800]);
    const thumb = rows.find((l) => l.kind === "thumb")!;
    expect(pngSize(join(dataDir, thumb.path))).toEqual([640, 400]);
    const desktop = rows.find((l) => l.kind === "desktop")!;
    expect(pngSize(join(dataDir, desktop.path))).toEqual([1280, 800]);
    // This app is private: a stranger is sent to sign in on another host,
    // so its thumb is taken as the owner, through the same grant door (#7830).
    const thumbCall = calls.find((c) => c.out.endsWith("-thumb.png"))!;
    const thumbGrant = readGrant(
      dataDir,
      new URL(thumbCall.url).searchParams.get("t") ?? "",
      { app: record, env: "production" },
    );
    expect(thumbGrant).toBeDefined();
    expect(thumbGrant?.who?.name).toBe("alice");
    expect(thumb.takenAs).toBe("owner");
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
    expect(await pictured(env, first)).toHaveLength(3);
    expect(calls).toHaveLength(6);
    // The entries the browser recorded reach the check's summary: the
    // phone's LCP and the desktop's CLS, graded; the thumb adds no row.
    // The look finished before any check run of this commit existed; the
    // check made afterwards still shows them.
    await looks.idle();
    expect(listRuns(app.db, repo.id, { kind: "check" })).toEqual([]);
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      commitOid: first,
      reason: "push",
    });
    const recorded = readLooks(dataDir, check);
    expect(recorded).toHaveLength(2);
    expect(recorded.map((l) => l.look).sort()).toEqual(["desktop", "phone"]);
    const graded = vitalsRows(recorded);
    // The phone's recorded size is stored beside its entries: two screens tall.
    expect(graded.find((g) => g.look === "phone")!.screens).toBe("2.0");
    expect(graded.find((g) => g.look === "phone")!.rows[0]).toMatchObject({
      vital: "LCP",
      value: "3100 ms",
      grade: "needs-improvement",
    });
    expect(graded.find((g) => g.look === "desktop")!.rows[1]).toMatchObject({
      vital: "CLS",
      value: "0.3",
      grade: "poor",
    });
    expect(new URL(calls[3]!.url).hostname).toBe(
      `hello--${pull.number}.${DOMAIN}`,
    );

    // The same head green again is not pictured again.
    runtime.requestDeploy(record, repo, env, first, "redeploy");
    expect(
      (await settled((r) => r.env === env && r.reason === "redeploy")).state,
    ).toBe("ok");
    await looks.idle();
    expect(calls).toHaveLength(6);
    expect(looksForEnv(app.db, record.id, env)).toHaveLength(3);

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
    expect(await pictured(env, second)).toHaveLength(3);
    expect(calls).toHaveLength(9);
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
    expect(page).toContain(`src="${base}/looks/${env}/${second}/phone.png?v=`);
    expect(page).toContain(`src="${base}/looks/${env}/${second}/desktop.png?v=`);
    expect(page).toContain(second.slice(0, 7));
    expect(page).not.toContain("the head has moved");

    // The page names the picture with its taking: that URL is kept for good.
    const src = new RegExp(`src="(${base}/looks/${env}/${second}/phone\\.png\\?v=\\d+)"`).exec(page)![1]!;
    const image = await web(src, aliceCookie);
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

  test("a picture asked for by its bare name carries an ETag, answers 304 to a match after the access check, and a retake changes the tag", async () => {
    const env = `pull-${pull.number}`;
    const url = `/alice/hello/looks/${env}/${second}/phone.png`;
    const ask = (cookie: string, match?: string) =>
      fetch(`${servers.url}${url}`, {
        headers: { cookie, ...(match === undefined ? {} : { "if-none-match": match }) },
        redirect: "manual",
      });
    const first200 = await ask(aliceCookie);
    expect(first200.status).toBe(200);
    const etag = first200.headers.get("etag")!;
    expect(etag).toMatch(/^"\d+"$/);
    expect(first200.headers.get("cache-control")).toBe("private, no-cache");

    const same = await ask(aliceCookie, etag);
    expect(same.status).toBe(304);
    expect((await same.arrayBuffer()).byteLength).toBe(0);
    expect(same.headers.get("cache-control")).toBe("private, no-cache");
    expect(same.headers.get("etag")).toBe(etag);

    // Not allowed to fetch it: the one 404, a matching tag or not.
    expect((await ask(bobCookie, etag)).status).toBe(404);
    expect((await ask("", etag)).status).toBe(404);

    // A retake at the same commit is a new tag; the old one gets the picture.
    const look = looksForEnv(app.db, record.id, env, "any").find(
      (l) => l.commitOid === second && lookSlot(l.page, l.kind, l.theme) === "phone",
    )!;
    await Bun.sleep(5);
    recordLook(app.db, {
      appId: record.id,
      env,
      commitOid: second,
      kind: look.kind,
      page: look.page,
      theme: look.theme,
      path: look.path,
    });
    const retaken = await ask(aliceCookie, etag);
    expect(retaken.status).toBe(200);
    expect(retaken.headers.get("etag")).not.toBe(etag);
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

  test("with no browser the check's summary says so and stays green", async () => {
    mode = "nobrowser";
    const env = `pull-${unpictured.number}`;
    const moved = await commitToBranch(app, alice, repo, {
      branch: "second",
      message: "No browser",
      files: [{ path: "SECOND.md", content: "no browser\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      commitOid: moved.value.commitOid,
      reason: "push",
    });
    expect(
      (await settled((r) => r.env === env && r.commitOid === moved.value.commitOid)).state,
    ).toBe("ok");
    await pictured(env, moved.value.commitOid);
    const got = await until(() => {
      const read = readLooks(dataDir, check);
      return read.length === 2 ? read : undefined;
    });
    expect(got).toEqual([
      { look: "phone", skipped: "no browser" },
      { look: "desktop", skipped: "no browser" },
    ]);
    // Words only: the table has no verdict to turn a check red.
    expect(vitalsRows(got).map((g) => g.skipped)).toEqual(["no browser", "no browser"]);
    expect(listRuns(app.db, repo.id, { kind: "check" }).find((r) => r.id === check.id)!.state).toBe("queued");
    mode = "ok";
  }, 120_000);

  test("a look recorded with no theme reads as light, and light and dark never share a slot", () => {
    const base = {
      appId: record.id,
      env: "production",
      commitOid: "a".repeat(40),
      kind: "phone" as const,
      path: "looks/x.png",
    };
    const old = recordLook(app.db, base);
    expect(old.theme).toBe("light");
    const dark = recordLook(app.db, { ...base, theme: "dark", path: "looks/x-dark.png" });
    expect(dark.id).not.toBe(old.id);
    expect(dark.theme).toBe("dark");
    expect(lookSlot("/", "phone")).toBe("phone");
    expect(lookSlot("/", "phone", "dark")).toBe("phone-dark");
    expect(lookSlot("/board", "phone", "dark")).toBe("board-phone-dark");
    const mine = (theme: "light" | "dark" | "any") =>
      looksForEnv(app.db, record.id, "production", theme).filter(
        (l) => l.commitOid === base.commitOid,
      );
    expect(mine("light").map((l) => l.path)).toEqual(["looks/x.png"]);
    expect(mine("dark").map((l) => l.path)).toEqual(["looks/x-dark.png"]);
    expect(mine("any")).toHaveLength(2);
  });

  test("what a page recorded is kept as plain numbers, a missing type as an empty list", () => {
    expect(
      parseRecorded({
        lcp: [{ startTime: 3100, size: 5, url: "http://x" }, "junk", { startTime: -1 }],
        layoutShift: [{ startTime: 1, value: 0.2, hadRecentInput: true }],
      }),
    ).toEqual({
      entries: {
        lcp: [{ startTime: 3100, size: 5 }],
        layoutShift: [{ startTime: 1, value: 0.2, hadRecentInput: true }],
        longtask: [],
      },
    });
    expect(parseRecorded(null).entries).toEqual({ lcp: [], layoutShift: [], longtask: [] });
    expect(parseRecorded("x").entries.lcp).toEqual([]);
  });

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

  test("a look is taken from `app.serving`, while the deploy's tests are still running, and a red check afterward does not remove it", async () => {
    // The app's test blocks on this file until the look has been taken.
    const gate = join(dataDir, "slow-red-test.gate");
    const branch = await commitToBranch(app, alice, repo, {
      branch: "slow-red-test",
      base: repo.defaultBranch,
      message: "Slow, then red, test",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                run: "bun run src/server.ts",
                test: `while [ ! -e '${gate}' ]; do sleep 0.05; done; exit 1`,
                tty: "bun run src/tty.ts",
              },
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Slow, then red, test",
      baseBranch: repo.defaultBranch,
      headBranch: "slow-red-test",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = `pull-${opened.value.number}`;
    const commitOid = branch.value.commitOid;

    // Pictured while the test step is held at the gate — the run is still
    // open, checking.
    const rows = await pictured(env, commitOid);
    expect(rows.every((l) => l.error === null)).toBe(true);
    const run = listRuns(app.db, repo.id, { env }).find(
      (r) => r.commitOid === commitOid,
    );
    expect(run?.state).toBe("running");
    const serving = listEvents(app.db, { repoId: repo.id, limit: 200 }).find(
      (e) => e.kind === "app.serving" && e.payload["commitOid"] === commitOid,
    );
    expect(serving?.payload["env"]).toBe(env);
    expect(serving?.payload["testsRunning"]).toBe(true);

    // The gate opens and the test finishes red; the run fails, but the
    // picture already taken of what is serving is untouched.
    writeFileSync(gate, "");
    const failed = await settled(
      (r) => r.env === env && r.commitOid === commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(
      looksForEnv(app.db, record.id, env).filter(
        (l) => l.commitOid === commitOid && l.error === null,
      ),
    ).toHaveLength(3);

    expect(
      (await setIssueStateThrough(app, alice, repo, opened.value, "closed")).ok,
    ).toBe(true);
  }, 30_000);

  test("two events for one environment, back to back, leave one queued look — at the newer commit", async () => {
    const before = calls.length;
    const live = runtime.envStatus(record, "production");
    if (live === undefined) throw new Error("production is not live");
    const superseded = `${"0".repeat(39)}1`;
    // Same tick, before the queue's pump has run at all: the second
    // replaces the first in `enqueue` rather than both being taken.
    app.bus.append({
      kind: "app.serving",
      repoId: repo.id,
      payload: {
        env: "production",
        commitOid: superseded,
        servingAt: new Date().toISOString(),
        testsRunning: true,
      },
    });
    app.bus.append({
      kind: "app.serving",
      repoId: repo.id,
      payload: {
        env: "production",
        commitOid: live.commitOid,
        servingAt: new Date().toISOString(),
        testsRunning: false,
      },
    });
    await looks.idle();
    // The superseded commit was never even looked at: production's own
    // head was already pictured (from the first test), so nothing new
    // was captured for it either.
    expect(calls.length).toBe(before);
    expect(
      looksForEnv(app.db, record.id, "production").some(
        (l) => l.commitOid === superseded,
      ),
    ).toBe(false);
  });

  test("the app's head shows production as a thumb", async () => {
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
    const production = looksForEnv(app.db, record.id, "production").find(
      (l) => l.kind === "thumb",
    )!;
    expect(page).toContain(`class="look" data-slot="now"`);
    expect(page).toContain(
      `src="/alice/hello/looks/production/${production.commitOid}/thumb.png?v=`,
    );

    // A commit pictured before the thumb kind existed has only its phone
    // and desktop rows — this is exactly that, with the thumb dropped —
    // and every slot that would show a thumb falls back to what it showed
    // before, rather than going blank.
    app.db
      .query(
        `DELETE FROM look WHERE app_id = ?1 AND env = ?2 AND kind = 'thumb'`,
      )
      .run(record.id, env);
    app.db
      .query(
        `DELETE FROM look WHERE app_id = ?1 AND env = 'production' AND kind = 'thumb'`,
      )
      .run(record.id);
    const fallback = await (await web("/alice/hello", studio)).text();
    const productionDesktop = looksForEnv(app.db, record.id, "production").find(
      (l) => l.kind === "desktop",
    )!;
    expect(fallback).toContain(
      `src="/alice/hello/looks/production/${productionDesktop.commitOid}/desktop.png?v=`,
    );
  }, 120_000);

  test("app.looks naming two pages pictures both, distinctly, and the pull page groups them", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "two-pages",
      base: repo.defaultBranch,
      message: "Look at two pages",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                run: "bun run src/server.ts",
                test: "bun test",
                tty: "bun run src/tty.ts",
                looks: ["/", "/board"],
              },
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Look at two pages",
      baseBranch: repo.defaultBranch,
      headBranch: "two-pages",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = `pull-${opened.value.number}`;
    const commitOid = branch.value.commitOid;
    expect((await settled((r) => r.env === env)).state).toBe("ok");

    const rows = await until(() => {
      const found = looksForEnv(app.db, record.id, env).filter(
        (l) => l.commitOid === commitOid,
      );
      return found.length === 6 ? found : undefined;
    }, 30_000);
    const home = rows.filter((l) => l.page === "/");
    const board = rows.filter((l) => l.page === "/board");
    expect(home).toHaveLength(3);
    expect(board).toHaveLength(3);
    // Two pages of one commit never collide on disk.
    expect(new Set(rows.map((l) => l.path)).size).toBe(6);
    const boardPhone = board.find((l) => l.kind === "phone")!;
    expect(boardPhone.path).toBe(
      `looks/${record.id}/${env}/${commitOid}-board-phone.png`,
    );
    const homePhone = home.find((l) => l.kind === "phone")!;
    expect(homePhone.path).toBe(
      `looks/${record.id}/${env}/${commitOid}-phone.png`,
    );
    // The browser was pointed at each page in turn.
    const boardCall = calls.find(
      (c) => new URL(c.url).searchParams.get("to") === "/board",
    );
    expect(boardCall).toBeDefined();

    const page = await (
      await web(`/alice/hello/pulls/${opened.value.number}`, aliceCookie)
    ).text();
    expect(page).toContain(`<p class="muted small">/</p>`);
    expect(page).toContain(`<p class="muted small">/board</p>`);
    expect(page).toContain(
      `src="/alice/hello/looks/${env}/${commitOid}/board-phone.png?v=`,
    );
    expect(page).toContain(
      `src="/alice/hello/looks/${env}/${commitOid}/phone.png?v=`,
    );
    expect(page).toContain(
      `alt="hello /board #${opened.value.number} on a phone"`,
    );
    expect(page).toContain(`alt="hello #${opened.value.number} on a phone"`);

    // Each page is also pictured in the dark, at phone and desktop, in a
    // slot of its own: the same page and kind, a different file.
    const dark = await until(() => {
      const found = looksForEnv(app.db, record.id, env, "dark").filter(
        (l) => l.commitOid === commitOid,
      );
      return found.length === 4 ? found : undefined;
    }, 30_000);
    expect(dark.every((l) => l.theme === "dark")).toBe(true);
    expect(dark.map((l) => l.kind).sort()).toEqual(["desktop", "desktop", "phone", "phone"]);
    expect(darkCalls.every((c) => c.dark === true)).toBe(true);
    const darkPhone = dark.find((l) => l.page === "/" && l.kind === "phone")!;
    expect(darkPhone.path).toBe(
      `looks/${record.id}/${env}/${commitOid}-phone-dark.png`,
    );
    expect(darkPhone.path).not.toBe(homePhone.path);
    expect(existsSync(join(dataDir, darkPhone.path))).toBe(true);
    expect(existsSync(join(dataDir, homePhone.path))).toBe(true);
    // The light listing is what every page has always shown: no dark row in it.
    expect(rows.some((l) => l.theme === "dark")).toBe(false);
    const served = await web(
      `/alice/hello/looks/${env}/${commitOid}/phone-dark.png`,
      aliceCookie,
    );
    expect(served.status).toBe(200);
    expect(lookUrl("/alice/hello", darkPhone)).toContain("/phone-dark.png?v=");
    // And it is on the pull page, as a link that works without script.
    const darkPage = await (
      await web(`/alice/hello/pulls/${opened.value.number}`, aliceCookie)
    ).text();
    expect(darkPage).toContain(
      `<a class="look" data-slot="phone" href="/alice/hello/looks/${env}/${commitOid}/phone-dark.png?v=`,
    );
    expect(darkPage).toContain(
      `src="/alice/hello/looks/${env}/${commitOid}/board-desktop-dark.png?v=`,
    );
    expect(darkPage).toContain(
      `alt="hello /board #${opened.value.number} on a desktop in the dark"`,
    );
    // The dark pair is named, and folded away until asked for.
    expect(darkPage).toMatch(
      /<details class="disclosure">\s*<summary class="muted small">In the dark<\/summary>/,
    );
    // An older head's dark picture never sits under the shown commit's caption.
    const stale = "b".repeat(40);
    recordLook(app.db, {
      appId: record.id,
      env,
      commitOid: stale,
      kind: "phone",
      theme: "dark",
      path: `looks/${record.id}/${env}/${stale}-phone-dark.png`,
    });
    const after = await (
      await web(`/alice/hello/pulls/${opened.value.number}`, aliceCookie)
    ).text();
    expect(after).not.toContain(stale);
    expect(after).toContain(`${commitOid}/phone-dark.png?v=`);
  }, 120_000);

  test("a private app's thumb taken as a stranger by an older forge is deleted on boot, to be retaken", async () => {
    const old = "c".repeat(40);
    const path = `looks/${record.id}/production/${old}-thumb.png`;
    mkdirSync(join(dataDir, dirname(path)), { recursive: true });
    writeFileSync(join(dataDir, path), "certificate warning");
    recordLook(app.db, {
      appId: record.id,
      env: "production",
      commitOid: old,
      kind: "thumb",
      path,
      takenAs: "nobody",
    });
    const again = startLooks(app, { localUrl: servers.url, capture: fake });
    await again.stop();
    expect(
      looksForEnv(app.db, record.id, "production").some((l) => l.commitOid === old),
    ).toBe(false);
    expect(existsSync(join(dataDir, path))).toBe(false);
  });

  test("the boot prune spares an owner-taken thumb, an attached one, and every thumb of a public app", async () => {
    const put = (oid: string, extra: Partial<Parameters<typeof recordLook>[1]>) => {
      const path = `looks/${record.id}/production/${oid}-thumb.png`;
      mkdirSync(join(dataDir, dirname(path)), { recursive: true });
      writeFileSync(join(dataDir, path), "a picture");
      recordLook(app.db, {
        appId: record.id,
        env: "production",
        commitOid: oid,
        kind: "thumb",
        path,
        ...extra,
      });
      return path;
    };
    const owned = put("d".repeat(40), { takenAs: "owner" });
    const attached = put("e".repeat(40), { takenAs: "nobody", attachedBy: alice.id });
    const stranger = put("f".repeat(40), { takenAs: "nobody" });
    const alive = (path: string): boolean => existsSync(join(dataDir, path));
    const rows = (): string[] =>
      looksForEnv(app.db, record.id, "production").map((l) => l.path);

    // A public app's thumbs are taken as a stranger by design: all stay.
    app.db.run("UPDATE app SET access = 'public' WHERE id = ?1", [record.id]);
    await startLooks(app, { localUrl: servers.url, capture: fake }).stop();
    app.db.run("UPDATE app SET access = 'private' WHERE id = ?1", [record.id]);
    for (const path of [owned, attached, stranger]) {
      expect(rows()).toContain(path);
      expect(alive(path)).toBe(true);
    }

    // Private again: only the stranger's goes, row and file.
    await startLooks(app, { localUrl: servers.url, capture: fake }).stop();
    expect(rows()).toContain(owned);
    expect(rows()).toContain(attached);
    expect(rows()).not.toContain(stranger);
    expect(alive(owned)).toBe(true);
    expect(alive(attached)).toBe(true);
    expect(alive(stranger)).toBe(false);
  });

  test("the sweep pictures a running production missing one: a thumb from before thumbs were the page is retaken (as the owner, the app being private); one that failed is not retried each sweep", async () => {
    const status = runtime.envStatus(record, "production")!;
    expect(status.state).toBe("running");
    const head = status.commitOid;
    // Whatever production lacks at its head now (an earlier test dropped
    // its thumb), the sweep takes.
    looks.sweep();
    await looks.idle();
    const thumbAtHead = (): Look | undefined =>
      looksForEnv(app.db, record.id, "production").find(
        (l) => l.kind === "thumb" && l.commitOid === head && l.page === "/",
      );
    const thumb = thumbAtHead()!;
    expect(thumb.error).toBeNull();

    // A thumb taken the old way: a 200×125 corner of the page.
    writeFileSync(
      join(dataDir, thumb.path),
      Buffer.from(encodePng(200, 125, new Uint8Array(200 * 125 * 4))),
    );
    const before = calls.length;
    looks.sweep();
    await looks.idle();
    expect(calls).toHaveLength(before + 1);
    const retaken = calls.at(-1)!;
    expect(retaken.out.endsWith("-thumb.png")).toBe(true);
    expect([retaken.width, retaken.height]).toEqual([1280, 800]);
    expect(
      readGrant(dataDir, new URL(retaken.url).searchParams.get("t") ?? "", {
        app: record,
        env: "production",
      })?.who?.name,
    ).toBe("alice");
    expect(pngSize(join(dataDir, thumbAtHead()!.path))).toEqual([640, 400]);

    // A whole set: nothing to take.
    looks.sweep();
    await looks.idle();
    expect(calls).toHaveLength(before + 1);

    // A picture that failed at this head had its turn: the sweep leaves
    // it to the next deploy rather than starting a browser every time.
    recordLook(app.db, {
      appId: record.id,
      env: "production",
      commitOid: head,
      kind: "thumb",
      path: "",
      error: "the browser fell over",
    });
    looks.sweep();
    await looks.idle();
    expect(calls).toHaveLength(before + 1);
  }, 60_000);

  test("pictures are shown only to those allowed to see them (#727): on a public repository hosting a private app, a stranger gets none, a signed-in reader the thumb, a writer all", async () => {
    // `hello` is a private app; its repository is made public here.
    expect(record.access).toBe("private");
    app.db.query(`UPDATE repo SET visibility = 'public' WHERE id = ?1`).run(repo.id);
    try {
      const head = runtime.envStatus(record, "production")!.commitOid;
      // The test before left this head's thumb failed; picture it again.
      const thumbPath = `looks/${record.id}/production/${head}-thumb.png`;
      const retake = () =>
        recordLook(app.db, {
          appId: record.id,
          env: "production",
          commitOid: head,
          kind: "thumb",
          path: thumbPath,
        });
      writeFileSync(join(dataDir, thumbPath), PNG);
      retake();
      const at = (kind: string) => `/alice/hello/looks/production/${head}/${kind}.png`;
      const status = async (kind: string, cookie: string) =>
        (await web(at(kind), cookie)).status;

      // A stranger cannot open a private app: no picture of it at all.
      for (const kind of ["desktop", "phone", "thumb"])
        expect(await status(kind, "")).toBe(404);
      // However the path is spelled, the same answer: every spelling the
      // route resolves reaches the one rule.
      for (const spelled of [
        `/ALICE/Hello/looks/production/${head}/desktop.png`,
        `//alice/hello/looks/production/${head}/desktop.png`,
        `/alice//hello/looks/production/${head}/desktop.png`,
        `/alice/hello.git/looks/production/${head}/desktop.png`,
        `/alice/%68ello/looks/production/${head}/desktop.png`,
        `/alice/hello/looks/production/${head}/%64esktop.png`,
        `/alice/hello/looks/production/${head.toUpperCase()}/desktop.png`,
        `/alice/hello/looks/production/${head}/desktop.png?v=1`,
        `/alice/hello/looks/production/${head}/thumb.png`,
      ]) {
        const answer = await web(spelled, "");
        expect(answer.status === 404 || answer.status >= 300).toBe(true);
        expect(answer.headers.get("content-type")).not.toBe("image/png");
      }
      const strangers = await (await web("/alice/hello", "forge_mode=studio")).text();
      expect(strangers).not.toContain("/looks/production/");
      // A signed-in reader may not enter a private app (#620): no picture.
      // Named by the app (#752), they may: the thumb, taken as nobody —
      // never the owner's phone or desktop.
      expect(await status("thumb", bobCookie)).toBe(404);
      setAppMembers(app.db, record.id, [bob.id], alice.id);
      expect(await status("desktop", bobCookie)).toBe(404);
      expect(await status("phone", bobCookie)).toBe(404);
      expect(await status("thumb", bobCookie)).toBe(200);
      const readers = await (await web("/alice/hello", `${bobCookie}; forge_mode=studio`)).text();
      expect(readers).toContain("/thumb.png?v=");
      expect(readers).not.toContain("/desktop.png");
      expect(readers).not.toContain("/phone.png");
      // A writer: all three.
      for (const kind of ["desktop", "phone", "thumb"])
        expect(await status(kind, aliceCookie)).toBe(200);

      // A public app: a stranger gets the thumb — but not one taken before
      // thumbs were taken as nobody (200 px wide, the owner's view).
      app.db.query(`UPDATE app SET access = 'public' WHERE id = ?1`).run(record.id);
      expect(await status("thumb", "")).toBe(200);
      expect(await status("desktop", "")).toBe(404);
      writeFileSync(
        join(dataDir, thumbPath),
        Buffer.from(encodePng(200, 125, new Uint8Array(200 * 125 * 4))),
      );
      expect(await status("thumb", "")).toBe(404);
      expect(await status("thumb", aliceCookie)).toBe(200);
      writeFileSync(join(dataDir, thumbPath), PNG);

      // Kept for good only under the name of this taking: a retake at the
      // same commit is a new URL, and the bare name is checked every time.
      const named = await (await web("/alice/hello", "forge_mode=studio")).text();
      const src = /src="([^"]*\/thumb\.png\?v=\d+)"/.exec(named)![1]!;
      const versioned = await web(src, "");
      expect(versioned.headers.get("cache-control")).toContain("immutable");
      expect((await web(at("thumb"), "")).headers.get("cache-control")).toBe(
        "private, no-cache",
      );
      await Bun.sleep(5);
      retake();
      const after = await (await web("/alice/hello", "forge_mode=studio")).text();
      expect(after).not.toContain(src);
      expect(after).toContain("/thumb.png?v=");
    } finally {
      app.db.query(`UPDATE app SET access = 'private' WHERE id = ?1`).run(record.id);
      app.db.query(`UPDATE repo SET visibility = 'private' WHERE id = ?1`).run(repo.id);
    }
  });

  test("a public app's previews are taken as nobody, so a reader of its pull sees the Look card; a picture taken as the owner stays the writers' (#738)", async () => {
    const made = await newApp(app, alice, { name: "gallery", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const gallery = made.value.repo;
    const galleryApp = made.value.app;
    expect(galleryApp.access).toBe("public");
    const branch = await commitToBranch(app, alice, gallery, {
      branch: "frame",
      base: gallery.defaultBranch,
      message: "A frame",
      files: [{ path: "FRAME.md", content: "frame\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, gallery, {
      title: "A frame",
      baseBranch: gallery.defaultBranch,
      headBranch: "frame",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = previewEnv(opened.value.number);
    const commit = branch.value.commitOid;
    expect((await settled((r) => r.env === env, gallery.id)).state).toBe("ok");
    const rows = await until(() => {
      const found = looksForEnv(app.db, galleryApp.id, env).filter(
        (l) => l.commitOid === commit,
      );
      return found.length === 3 ? found : undefined;
    }, 30_000);
    // All three taken as nobody, and the browser was told so.
    expect(rows.map((l) => l.takenAs)).toEqual(["nobody", "nobody", "nobody"]);
    const phoneCall = calls.filter((c) => c.out.includes(galleryApp.id) || c.url.includes("gallery")).find((c) => c.width === 390)!;
    expect(
      readGrant(dataDir, new URL(phoneCall.url).searchParams.get("t") ?? "", {
        app: galleryApp,
        env,
      })?.who,
    ).toBeUndefined();
    // A reader and a stranger fetch them, and the pull shows the reader its Look.
    const at = (kind: string) => `/alice/gallery/looks/${env}/${commit}/${kind}.png`;
    for (const cookie of ["", bobCookie]) {
      expect((await web(at("phone"), cookie)).status).toBe(200);
      expect((await web(at("desktop"), cookie)).status).toBe(200);
    }
    const pullPage = await (
      await web(`/alice/gallery/pulls/${opened.value.number}`, bobCookie)
    ).text();
    expect(pullPage).toContain("<h2>Look</h2>");
    expect(pullPage).toContain(`/alice/gallery/looks/${env}/${commit}/phone.png?v=`);
    // A picture taken as the owner — every picture before #738 — stays the
    // writers', even of a public app.
    app.db
      .query(`UPDATE look SET taken_as = 'owner' WHERE app_id = ?1 AND env = ?2`)
      .run(galleryApp.id, env);
    expect((await web(at("phone"), bobCookie)).status).toBe(404);
    expect((await web(at("phone"), aliceCookie)).status).toBe(200);
    const after = await (
      await web(`/alice/gallery/pulls/${opened.value.number}`, bobCookie)
    ).text();
    expect(after).not.toContain("<h2>Look</h2>");
  }, 120_000);

  test("a public app made private after its pictures were taken: a reader gets them no more, and no Look card; its writer still does (#845)", async () => {
    // Its own app, branch, pull and pictures: no other test's capture.
    const made = await newApp(app, alice, { name: "vault", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const gallery = made.value.repo;
    const galleryApp = made.value.app;
    const branch = await commitToBranch(app, alice, gallery, {
      branch: "frame",
      base: gallery.defaultBranch,
      message: "A frame",
      files: [{ path: "FRAME.md", content: "frame\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, gallery, {
      title: "A frame",
      baseBranch: gallery.defaultBranch,
      headBranch: "frame",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = previewEnv(opened.value.number);
    const commitOid = branch.value.commitOid;
    mkdirSync(join(dataDir, "looks", galleryApp.id, env), { recursive: true });
    for (const kind of ["thumb", "desktop", "phone"] as const) {
      const path = `looks/${galleryApp.id}/${env}/${commitOid}-${kind}.png`;
      writeFileSync(join(dataDir, path), PNG);
      // Taken as nobody while the app was public.
      recordLook(app.db, {
        appId: galleryApp.id,
        env,
        commitOid,
        kind,
        path,
        takenAs: "nobody",
      });
    }
    const look = looksForEnv(app.db, galleryApp.id, env).find(
      (l) => l.kind === "phone" && l.error === null,
    )!;
    const at = `/alice/vault/looks/${env}/${look.commitOid}/phone.png`;
    expect((await web(at, bobCookie)).status).toBe(200);
    const pull = opened.value;
    const card = async (cookie: string) =>
      (await (await web(`/alice/vault/pulls/${pull.number}`, cookie)).text()).includes("<h2>Look</h2>");
    expect(await card(bobCookie)).toBe(true);
    // Made private: the same files, asked again on every fetch.
    app.db.query(`UPDATE app SET access = 'private' WHERE id = ?1`).run(galleryApp.id);
    try {
      expect((await web(at, bobCookie)).status).toBe(404);
      expect((await web(at, "")).status).toBe(404);
      expect(await card(bobCookie)).toBe(false);
      expect((await web(at, aliceCookie)).status).toBe(200);
      expect(await card(aliceCookie)).toBe(true);
    } finally {
      app.db.query(`UPDATE app SET access = 'public' WHERE id = ?1`).run(galleryApp.id);
    }
  });

  test("a pull's look of a page sits beside main's newest look of it, or says main has none", async () => {
    const env = previewEnv(pull.number);
    const oid = "a".repeat(40);
    const mainOid = "b".repeat(40);
    const put = (e: string, commitOid: string, page: string) =>
      recordLook(app.db, {
        appId: record.id,
        env: e,
        commitOid,
        page,
        kind: "phone",
        path: `looks/${record.id}/${e}/${commitOid}-x-phone.png`,
      });
    put(env, oid, "/map");
    put(env, oid, "/solo");
    put("production", mainOid, "/map");
    const text = await (
      await web(`/alice/hello/pulls/${pull.number}`, aliceCookie)
    ).text();
    const group = (page: string) =>
      text.split(`<p class="muted small">${page}</p>`)[1]!.split("<section")[0]!;
    const map = group("/map");
    expect(map).toContain(`/looks/production/${mainOid}/map-phone.png?v=`);
    expect(map).toContain(`/looks/${env}/${oid}/map-phone.png?v=`);
    expect(map.indexOf("Before")).toBeLessThan(map.indexOf("After"));
    expect(map.indexOf(`/looks/production/`)).toBeLessThan(
      map.indexOf(`/looks/${env}/`),
    );
    expect(map).not.toContain("has no look");
    expect(map).toContain(`/commit/${mainOid}`);
    const solo = group("/solo");
    expect(solo).toContain("Main has no look of /solo yet.");
    expect(solo).not.toContain("/looks/production/");
  });

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
      expect(taken.ok).toBe(true);
      // The observer ran before the page: every type is a list, as far as this browser has it.
      const entries = taken.ok ? taken.value.entries : undefined;
      expect(Array.isArray(entries?.lcp)).toBe(true);
      expect(Array.isArray(entries?.layoutShift)).toBe(true);
      expect(Array.isArray(entries?.longtask)).toBe(true);
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
  test.skipIf(chromium === undefined)(
    "a capture that ends on the browser's error page fails with its reason and writes no picture",
    async () => {
      const page: ReturnType<typeof Bun.serve> = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        // Off the app's host, on a name that resolves to loopback without DNS.
        fetch: (request): Response =>
          new URL(request.url).pathname === "/"
            ? new Response(null, {
                status: 302,
                headers: { location: `http://localhost:${page.port}/landed` },
              })
            : new Response("<!doctype html><p>elsewhere</p>", {
                headers: { "content-type": "text/html" },
              }),
      });
      try {
        const out = join(dataDir, "refused.png");
        const taken = await takeLook({
          url: `http://127.0.0.1:${page.port}/`,
          out,
          width: 390,
          height: 844,
          timeoutMs: 30_000,
        });
        expect(JSON.stringify(taken)).toContain("left the app's host for localhost");
        // The guard throws before the screenshot: no picture was written.
        expect(existsSync(out)).toBe(false);
      } finally {
        page.stop(true);
      }
    },
    120_000,
  );
  test.skipIf(chromium === undefined)(
    "a dark capture is truly dark: the same page, light and dark, differs in its pixels",
    async () => {
      const page = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          new Response(
            "<!doctype html><style>body{margin:0;background:#fff}@media (prefers-color-scheme: dark){body{background:#000}}</style><p>hi</p>",
            { headers: { "content-type": "text/html" } },
          ),
      });
      try {
        const corner = async (dark: boolean): Promise<number> => {
          const out = join(dataDir, `scheme-${dark ? "dark" : "light"}.png`);
          const taken = await takeLook({
            url: `http://127.0.0.1:${page.port}/`,
            out,
            width: 390,
            height: 844,
            dark,
            timeoutMs: 30_000,
          });
          expect(taken.ok).toBe(true);
          const image = decodePng(readFileSync(out));
          if (!image.ok) throw new Error(image.error);
          const last = image.value.rgba.length - 4;
          return image.value.rgba[last]!;
        };
        expect(await corner(false)).toBe(255);
        expect(await corner(true)).toBe(0);
      } finally {
        page.stop(true);
      }
    },
    120_000,
  );
});
