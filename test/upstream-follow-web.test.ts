/**
 * Following an upstream, at the doors (#3980): the API and the settings
 * card are an admin's; everyone else gets 404 and sees nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { checkUpstream } from "../src/actions/upstream_follow.ts";
import { listEvents } from "../src/core/events.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let base = "";
let alice = "";
let guest = "";
const URL_ = "https://example.com/up/stream.git";

type Body = { following: { url: string; branch: string; enabled: boolean } | null };

const signIn = async (username: string): Promise<string> =>
  (
    (
      await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username, password: "a-good-passphrase" }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;

const api = (cookie: string, method: string, path: string, json?: object, origin = base) =>
  fetch(`${base}/api/v1/repos/alice/square/upstream${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      origin,
      "content-type": "application/json",
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });

const read = async (cookie: string): Promise<Body> => (await api(cookie, "GET", "")).json() as Promise<Body>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-follow-web-"));
  app = createApp({ dataDir, port: 0 });
  const make = async (username: string, extra: object = {}) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...extra,
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return made.value;
  };
  const owner = await make("alice", { adminIfFirst: true });
  await make("guest");
  const made = await createRepo(app, owner, { name: "square", visibility: "public" });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const seeded = await commitToBranch(app, owner, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# square\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  servers = await serve(app);
  base = servers.url;
  alice = await signIn("alice");
  guest = await signIn("guest");
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the API", () => {
  test("anonymous is 401, a stranger is 404, the admin reads null", async () => {
    expect((await api("", "GET", "")).status).toBe(401);
    expect((await api(guest, "GET", "")).status).toBe(404);
    const read = await api(alice, "GET", "");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ following: null });
  });

  test("a stranger cannot set or check; a cross-origin set is refused", async () => {
    const put = { url: URL_, branch: "main", enabled: true };
    expect((await api(guest, "PUT", "", put)).status).toBe(404);
    expect((await api(guest, "POST", "/check")).status).toBe(404);
    expect((await api(alice, "PUT", "", put, "https://evil.example")).status).toBe(403);
    expect((await read(alice))).toEqual({ following: null });
  });

  test("input is validated by upstreamUrl and the branch is checked", async () => {
    for (const url of ["git://example.com/a.git", "ssh://git@example.com/a", "https://u:p@example.com/a", "file:///etc"]) {
      const res = await api(alice, "PUT", "", { url, branch: "main", enabled: true });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_url");
    }
    const bad = await api(alice, "PUT", "", { url: URL_, branch: "-x", enabled: true });
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_branch");
    expect((await api(alice, "PUT", "", { url: URL_ })).status).toBe(422);
  });

  test("an admin sets, reads, checks and turns it off", async () => {
    const off = await api(alice, "POST", "/check");
    expect([off.status, ((await off.json()) as { error: string }).error]).toEqual([422, "off"]);
    const set = await api(alice, "PUT", "", { url: URL_, branch: "main", enabled: true });
    expect(set.status).toBe(200);
    expect(((await set.json()) as Body).following).toMatchObject({ url: URL_, branch: "main", enabled: true });
    expect((await read(alice)).following?.enabled).toBe(true);
    // Unreachable from here: the check fails and says why, it does not throw.
    const checked = await api(alice, "POST", "/check");
    expect([200, 422]).toContain(checked.status);
    const cleared = await api(alice, "PUT", "", { url: "", branch: "", enabled: false });
    expect(((await cleared.json()) as Body).following).toMatchObject({ url: URL_, enabled: false });
  });
});

describe("the pages", () => {
  const settings = async (cookie: string) =>
    (await fetch(`${base}/alice/square/settings`, { headers: cookie ? { cookie } : {} })).text();
  const about = async (cookie: string) =>
    (await fetch(`${base}/alice/square`, { headers: cookie ? { cookie } : {} })).text();

  test("the card renders for an admin and the About line shows only when on", async () => {
    expect(await settings(alice)).toContain("Follow upstream");
    expect(await about(alice)).not.toContain("data-following-upstream");
    await api(alice, "PUT", "", { url: URL_, branch: "main", enabled: true });
    expect(await settings(alice)).toContain("Check upstream now");
    expect(await about(alice)).toContain("data-following-upstream");
    expect(await about(alice)).toContain("example.com/up/stream");
  });

  test("a guest and a stranger see none of it", async () => {
    expect(await about(guest)).not.toContain("data-following-upstream");
    expect(await about("")).not.toContain("example.com/up/stream");
    expect(await settings(guest)).not.toContain("Check upstream now");
  });

  test("the form posts are an admin's and same-origin", async () => {
    const post = (cookie: string, origin: string) =>
      fetch(`${base}/alice/square/settings/upstream`, {
        method: "POST",
        headers: { cookie, origin },
        body: new URLSearchParams({ url: "https://example.com/other.git", branch: "dev", enabled: "on" }),
        redirect: "manual",
      });
    expect((await post(guest, base)).status).toBe(404);
    expect((await post(alice, "https://evil.example")).status).toBe(403);
    expect((await post(alice, base)).status).toBe(303);
    expect((await read(alice)).following?.branch).toBe("dev");
  });

  test("the check post is an admin's and same-origin, and says what it found", async () => {
    const check = (cookie: string, origin: string) =>
      fetch(`${base}/alice/square/settings/upstream/check`, {
        method: "POST",
        headers: { cookie, origin },
        redirect: "manual",
      });
    const flashOf = (res: Response) => decodeURIComponent(res.headers.get("set-cookie") ?? "") + (res.headers.get("location") ?? "");
    expect((await check(guest, base)).status).toBe(404);
    expect((await check(alice, "https://evil.example")).status).toBe(403);
    // On, but nothing reachable from here: the admin is told, not thrown at.
    await api(alice, "PUT", "", { url: URL_, branch: "main", enabled: true });
    const done = await check(alice, base);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toContain("/alice/square/settings#upstream");
    // Off: the same post answers that the check is off.
    await api(alice, "PUT", "", { url: "", branch: "", enabled: false });
    const off = await check(alice, base);
    expect(off.status).toBe(303);
    expect(flashOf(off)).toContain("Following an upstream is off");
  });
});

describe("the check's event", () => {
  const checked = () =>
    listEvents(app.db, {}).filter((e) => e.kind === "repo.upstream_checked");

  test("one event with an empty payload per check, and none when it is off", async () => {
    const repo = getRepo(app.db, "alice", "square")!;
    const put = (enabled: boolean) =>
      api(alice, "PUT", "", { url: URL_, branch: "main", enabled });
    await put(false);
    const before = checked().length;
    expect((await checkUpstream(app, repo)).ok).toBe(false);
    expect(checked().length).toBe(before);
    await put(true);
    await checkUpstream(app, repo);
    const after = checked();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.payload).toEqual({});
    expect(after.at(-1)?.repoId).toBe(repo.id);
  });
});
