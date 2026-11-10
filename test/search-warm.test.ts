/** The probe's search is read behind the listener, and a failed warm is only a cold first visit (#11059). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { search } from "../src/actions/search.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { MIN_CODE_QUERY, grepCount } from "../src/core/search.ts";
import { WARM_QUERY, warmSearch } from "../src/search/warm.ts";

let dir = "";
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-warm-"));
  app = createApp({ dataDir: dir, port: 0 });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a warm fills the grep cache: a budgeted visit then finds every repository's code", async () => {
  const servers = await serve(app);
  try {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const bearer = createToken(app.db, made.value.id, "t", "admin").token;
    const post = (path: string, body: unknown) =>
      fetch(servers.url + path, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Four public repositories, each holding the query.
    for (let i = 0; i < 4; i++) {
      await post("/api/v1/repos", { name: `w${i}`, visibility: "public" });
      await post(`/api/v1/repos/alice/w${i}/contents`, {
        branch: "main", message: "c", files: [{ path: "a.txt", content: "an\n" }],
      });
    }
    // Unwarmed, this budgeted visit would grep all four itself.
    const budgeted = () => search(app, undefined, { q: WARM_QUERY, kind: "code", codeBudgetMs: 5_000 });
    // The default warm greps: its query is long enough (#11120).
    expect([...WARM_QUERY].length).toBeGreaterThanOrEqual(MIN_CODE_QUERY);
    const before = grepCount();
    await warmSearch(app);
    expect(grepCount() - before).toBeGreaterThanOrEqual(4);
    const ran = grepCount();
    const warm = await budgeted();
    expect(grepCount()).toBe(ran); // served from the grep cache, no git spawned
    expect(warm.moreCode).toBe(false);
    expect(warm.codeSkipped).toBe(false);
    expect(new Set(warm.code.map((h) => h.repo)).size).toBe(4);
  } finally {
    servers.stop();
  }
}, 120_000);

test("a search that throws is logged, never raised", async () => {
  const logged: string[] = [];
  const broken = { ...app, db: undefined, log: { ...app.log, error: (m: string) => void logged.push(m) } } as unknown as typeof app;
  await warmSearch(broken);
  expect(logged).toEqual(["search warm failed"]);
});
