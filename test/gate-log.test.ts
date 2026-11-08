/** Every gate keeps its log, per repository, the last 20 (#6351). */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_GATES, keepGateLog, readGateLog } from "../src/checks/gate_log.ts";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { landVerdict } from "../src/checks/tiers.ts";

quietLogs();

const dirs: string[] = [];
const data = (): string => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gate-log-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const red = ["test/a.test.ts:", "(pass) one", "(fail) two"];

test("a red gate outside forgeRepo leaves a readable log", () => {
  const d = data();
  const lines = [...Array.from({ length: 300 }, (_, i) => `line ${i}`), ...red];
  const id = keepGateLog(d, "ann/app", "abcdef1234567890", false, lines, 1_000)!;
  const kept = readGateLog(d, "ann", "app", id)!;
  expect(kept.ok).toBe(false);
  expect(kept.files).toEqual({ "test/a.test.ts": "fail" });
  expect(kept.tail).toHaveLength(200);
  expect(kept.tail.at(-1)).toBe("(fail) two");
});

test("the 21st gate drops the oldest", () => {
  const d = data();
  const ids = Array.from({ length: KEEP_GATES + 1 }, (_, i) =>
    keepGateLog(d, "ann/app", "abcdef12", true, red, 1_000 + i)!,
  );
  expect(readGateLog(d, "ann", "app", ids[0]!)).toBeUndefined();
  for (const id of ids.slice(1)) expect(readGateLog(d, "ann", "app", id)).toBeDefined();
  expect(readGateLog(d, "bob", "app", ids[1]!)).toBeUndefined();
});

test("odd names and ids are refused", () => {
  const d = data();
  expect(keepGateLog(d, "../x", "abcdef12", true, red, 1)).toBeUndefined();
  expect(readGateLog(d, "ann", "app", "../../x")).toBeUndefined();
});

test("the landing note names the red tests and links the kept log", () => {
  const note = (tests: string[]): string =>
    (landVerdict(false, tests, [], "/api/v1/repos/ann/app/gates/x/log") as { comment: string })
      .comment;
  expect(note(["two"])).toContain("- two");
  expect(note(["two"])).toContain("/gates/x/log");
  expect(note([])).toContain("/gates/x/log");
});

describe("GET /api/v1/repos/:owner/:name/gates/:id/log", () => {
  let dataDir: string;
  let app: App;
  let http: ForgeHttp;
  let id: string;
  const token: Record<string, string> = {};

  const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const get = async (path: string, who?: string) => {
    const res = await http.handle(
      new Request(`http://forge.test${path}`, {
        headers: who === undefined ? {} : { authorization: `Bearer ${token[who]}` },
      }),
    );
    return { res, text: await res.text() };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gate-route-"));
    app = createApp({ dataDir, port: 0 });
    http = forgeHttp(app);
    const mk = async (username: string, adminIfFirst = false) =>
      ok(
        await createUser(app.db, {
          origin: "seed",
          trusted: true,
          username,
          email: `${username}@forge.local`,
          password: "a-good-passphrase",
          adminIfFirst,
        }),
      );
    const alice = await mk("alice", true);
    const mallory = await mk("mallory");
    const repo = ok(await createRepo(app, alice, { name: "vault", visibility: "private" }));
    ok(
      await commitToBranch(app, alice, repo, {
        message: "Start",
        files: [{ path: "README.md", content: "# vault\n" }],
      }),
    );
    token.alice = createToken(app.db, alice.id, "t", "rw").token;
    token.mallory = createToken(app.db, mallory.id, "t", "rw").token;
    id = keepGateLog(dataDir, "alice/vault", "abcdef1234567890", false, red, 5_000)!;
  }, 60_000);

  afterAll(() => {
    app?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const path = (which = id): string => `/api/v1/repos/alice/vault/gates/${which}/log`;

  test("a guest and a non-member get 404 on a private repository's gate", async () => {
    expect((await get(path())).res.status).toBe(404);
    expect((await get(path(), "mallory")).res.status).toBe(404);
  });

  test("the owner reads it as no-store text under a header line", async () => {
    const { res, text } = await get(path(), "alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(text.startsWith("# gate red at")).toBe(true);
    expect(text.trimEnd().split("\n").at(-1)).toBe("(fail) two");
  });

  test("an unknown id is 404 for the owner", async () => {
    expect((await get(path("0000000005000-123456abcdef"), "alice")).res.status).toBe(404);
    expect((await get(path("nope"), "alice")).res.status).toBe(404);
  });
});
