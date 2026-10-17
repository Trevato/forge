import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const SECRET = "zebra-quartz-plan";
const PASSWORD = "a-good-passphrase";

describe("a private repository's page and card, seen anonymously", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-og-private-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, {
      name: "vault",
      visibility: "private",
      description: `Holds the ${SECRET}`,
    });
    if (!made.ok) throw new Error(String(made.error));
    const issue = createIssue(app.db, {
      repoId: getRepo(app.db, "alice", "vault")!.id,
      authorId: u.value.id,
      title: "An issue",
      kind: "issue",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(servers.url + path, { headers, redirect: "manual" });

  test("the page answered anonymously leaks nothing in its head", async () => {
    const res = await get("/alice/vault");
    const head = (await res.text()).split("</head>")[0]!;
    expect(head).not.toContain(SECRET);
    expect(head).toContain('property="og:title" content="Not found"');
    expect(head).not.toContain("/og/repo/");
  });

  test("the card says a title and 'private' and nothing else", async () => {
    const res = await get("/og/repo/alice~vault.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const svg = await res.text();
    expect(svg).toContain("alice/vault");
    expect(svg).toContain("private");
    expect(svg).not.toContain(SECRET);
    expect(svg).not.toMatch(/issues|pulls|ready now|crew/);
  });

  test("a name nobody has taken gets a card of the same shape", async () => {
    const real = await (await get("/og/repo/alice~vault.svg")).text();
    const none = await (await get("/og/repo/alice~nothing.svg")).text();
    expect(none).toBe(real.replaceAll("alice/vault", "alice/nothing"));
  });

  test("the owner, signed in, sees the full card, for them alone", async () => {
    const res = await get("/og/repo/alice~vault.svg", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const svg = await res.text();
    expect(svg).toContain(SECRET);
    expect(svg).toContain("1 issues");
  });

  test("the owner's page points at the card", async () => {
    const html = await (await get("/alice/vault", { cookie })).text();
    expect(html).toContain("/og/repo/alice~vault.png");
  });
});
