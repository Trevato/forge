/**
 * The recovery page for a connected Forgejo's archived repositories, driven
 * over HTTP as a browser would, against a fake Forgejo in this process.
 */
import { everyoneIsAMember } from "./helpers/members.ts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOrigin } from "../src/actions/origins.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import {
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeRepo,
} from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "octo-archive-token";

describe("restoring archived repositories", () => {
  let fake: FakeForge;
  let app: App;
  let servers: Servers;
  let ada: User;
  let adaCookie = "";
  let bobCookie = "";
  let path = "";

  const repo = (name: string, extra: Partial<FakeRepo> = {}): FakeRepo => ({
    id: fake.state.nextId++,
    fullName: `octo/${name}`,
    cloneUrl: `${fake.url}/octo/${name}.git`,
    archived: true,
    ...extra,
  });

  const get = async (
    cookie: string,
    url = path,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${servers.url}${url}`, {
      headers: { cookie },
      redirect: "manual",
    });
    return { status: response.status, text: await response.text() };
  };

  const post = (
    fields: [string, string][],
    cookie = adaCookie,
    origin = servers.url,
  ): Promise<Response> =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  const patches = (): number =>
    fake.state.requests.filter(
      (r) => r.method === "PATCH" && !r.path.includes("forge-write-check"),
    ).length;

  beforeAll(async () => {
    fake = serveFakeForge(newFakeState("forgejo", "octo", TOKEN));
    app = createApp({
      dataDir: await mkdtemp(join(tmpdir(), "forge-archived-")),
      port: 0,
    });
    everyoneIsAMember(app.db);
    servers = await serve(app);
    const made = async (username: string): Promise<User> => {
      const user = await createUser(app.db, {
        username,
        email: `${username}@forge.test`,
        password: "a-long-archive-passphrase",
        origin: "seed",
        trusted: true,
      });
      if (!user.ok) throw new Error(user.error);
      return user.value;
    };
    ada = await made("ada");
    adaCookie = `forge_session=${createSession(app.db, ada.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, (await made("bob")).id).token}`;
    const connected = await connectOrigin(app, ada, {
      host: fake.url,
      token: TOKEN,
    });
    if (!connected.ok) throw new Error(JSON.stringify(connected.error));
    path = `/settings/origins/${connected.value.id}/archived`;
  });

  afterAll(() => {
    servers.stop();
    forgetProviders(app.config.dataDir);
    fake.stop();
  });

  beforeEach(() => {
    fake.state.repos = [];
    fake.state.requests.length = 0;
    delete fake.state.repoWriteScopeMissing;
  });

  test("the origin's page leads here, and the page says what restoring does", async () => {
    expect((await get(adaCookie, "/settings/origins")).text).toContain(
      `href="${path}"`,
    );
    fake.state.repos = [repo("one", { archivedAt: "2026-10-01T00:00:00Z" })];
    const { text } = await get(adaCookie);
    expect(text).toContain("makes it writable again");
    expect(text).toContain("may need starting there");
    expect(text).toContain('datetime="2026-10-01');
    expect(text).toContain(
      `/bring?link=${encodeURIComponent(`${fake.url}/octo/one`)}`,
    );
    expect(text).toContain("Restore");
  });

  test("the zero time is not shown as a date", async () => {
    fake.state.repos = [repo("old")];
    expect((await get(adaCookie)).text).not.toContain("archived <time");
  });

  test("nothing archived, and nothing matching", async () => {
    fake.state.repos = [repo("live", { archived: false })];
    expect((await get(adaCookie)).text).toContain("No archived repositories");
    fake.state.repos = [repo("one")];
    expect((await get(adaCookie, `${path}?q=zzz`)).text).toContain(
      "No matches",
    );
  });

  test("236 archived: a filter and pages that reach them all", async () => {
    fake.state.repos = Array.from({ length: 236 }, (_, i) =>
      repo(`r${String(i).padStart(3, "0")}`),
    );
    const first = await get(adaCookie);
    expect(first.text).toContain("236 archived");
    expect(first.text).toContain("Page 1");
    expect(first.text).toContain(`${path}?page=2`);
    const last = await get(adaCookie, `${path}?page=5`);
    expect(last.text).toContain("r235");
    expect(last.text).not.toContain(`${path}?page=6`);
    const filtered = await get(adaCookie, `${path}?q=r2${"3"}5`);
    expect(filtered.text).toContain("1 archived");
    expect(filtered.text).not.toContain("r000");
  });

  test("one Restore changes it on the origin and reports the re-read", async () => {
    fake.state.repos = [repo("one"), repo("two")];
    const response = await post([["one", "octo/one"]]);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("Restored 1 of 1");
    expect(fake.state.repos[0]!.archived).toBe(false);
    expect(fake.state.repos[1]!.archived).toBe(true);
    expect(
      fake.state.requests.some(
        (r) => r.method === "GET" && r.path.endsWith("/repos/octo/one"),
      ),
    ).toBe(true);
  });

  test("an origin that takes the change but still says archived is reported as that", async () => {
    fake.state.repos = [repo("stuck", { ignoresPatch: true })];
    const text = await (await post([["one", "octo/stuck"]])).text();
    expect(text).toContain("Restored 0 of 1");
    expect(text).toContain("still says this repository is archived");
  });

  test("a partly failed batch: per-row results and a retry on the failure only", async () => {
    fake.state.repos = [
      repo("good"),
      repo("theirs", { admin: false }),
      repo("also"),
    ];
    const text = await (
      await post([
        ["selected", "1"],
        ["repo", "octo/good"],
        ["repo", "octo/theirs"],
        ["repo", "octo/also"],
      ])
    ).text();
    expect(text).toContain("Restored 2 of 3");
    expect(text).toContain("takes admin on it");
    expect(text).toMatch(/value="octo\/theirs"[^>]*>\s*Retry/);
    expect(text).not.toMatch(/value="octo\/good"[^>]*>\s*Retry/);
    expect(fake.state.repos.map((r) => r.archived)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("a repository this connection can't change offers no Restore, only the way to bring it", async () => {
    fake.state.repos = [repo("theirs", { admin: false })];
    const { text } = await get(adaCookie);
    expect(text).toContain("Needs admin");
    expect(text).not.toContain(`value="octo/theirs"`);
    expect(text).toContain("Bring here");
  });

  test("a token that can't write: the exact scope, before anything is pressed", async () => {
    fake.state.repos = [repo("one")];
    fake.state.repoWriteScopeMissing = "write:repository";
    const { text } = await get(adaCookie);
    expect(text).toContain("Repository: Read and write");
    expect(text).toContain("write:repository");
    expect(text).toContain("This token cannot restore anything");
    expect(text).toContain("Replace the token");
    expect(text).not.toContain('role="alert"');
    // Everything in <main> above the list's form: no card, so no alert box.
    const above = text.slice(
      text.indexOf("<main"),
      text.indexOf('<form method="post" action="' + path),
    );
    expect(above).toContain("This token cannot restore anything");
    expect(above).not.toContain('class="card');
    expect(text).not.toContain(`name="one"`);
    expect(patches()).toBe(0);
    expect(fake.state.repos[0]!.archived).toBe(true);
    // Pressed anyway, from a stale page: refused in the same words.
    const posted = await (await post([["one", "octo/one"]])).text();
    expect(posted).toContain("missing Repository: Read and write");
    expect(fake.state.repos[0]!.archived).toBe(true);
  });

  test("the origin unreachable: said plainly, with a retry", async () => {
    const down = serveFakeForge(newFakeState("forgejo", "gone", "gone-token"));
    const connected = await connectOrigin(app, ada, {
      host: down.url,
      token: "gone-token",
    });
    if (!connected.ok) throw new Error(JSON.stringify(connected.error));
    down.stop();
    const at = `/settings/origins/${connected.value.id}/archived`;
    const { status, text } = await get(adaCookie, at);
    expect(status).toBe(200);
    expect(text).toContain("could not be reached");
    expect(text).toContain("Try again");
  });

  test("a POST from another site changes nothing", async () => {
    fake.state.repos = [repo("one")];
    const response = await post(
      [["one", "octo/one"]],
      adaCookie,
      "https://evil.example",
    );
    expect(response.status).toBe(403);
    expect(fake.state.repos[0]!.archived).toBe(true);
    expect(patches()).toBe(0);
  });

  test("another account can neither see nor use the connection", async () => {
    fake.state.repos = [repo("secret")];
    const seen = await get(bobCookie);
    expect(seen.status).toBe(404);
    expect(seen.text).not.toContain("secret");
    const posted = await post([["one", "octo/secret"]], bobCookie);
    expect(posted.status).toBe(404);
    expect(fake.state.repos[0]!.archived).toBe(true);
    expect(patches()).toBe(0);
    expect((await get("")).status).toBeGreaterThanOrEqual(300);
  });
});
