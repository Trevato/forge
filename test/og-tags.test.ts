import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** The head tags a link preview reads, by `property`/`name`. */
function tags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\s+(?:property|name)="((?:og|twitter):[^"]+)"\s+content="([^"]*)"/g))
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  return out;
}

describe("every kind of page unfurls", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ogtags-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
    const hidden = await createRepo(app, u.value, { name: "hidden", visibility: "private" });
    if (!hidden.ok) throw new Error(String(hidden.error));
    const secret = createIssue(app.db, {
      repoId: getRepo(app.db, "alice", "hidden")!.id,
      authorId: u.value.id,
      title: "A private issue",
      kind: "issue",
    });
    if (!secret.ok) throw new Error(String(secret.error));
    const made = await createRepo(app, u.value, { name: "shown", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repoId = getRepo(app.db, "alice", "shown")!.id;
    for (const [kind, sealed] of [
      ["issue", false],
      ["pull", false],
      ["issue", true],
      ["pull", true],
    ] as const) {
      const i = createIssue(app.db, { repoId, authorId: u.value.id, title: `A ${kind}`, kind, sealed });
      if (!i.ok) throw new Error(String(i.error));
      if (kind === "pull")
        app.db
          .query(
            `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
             VALUES (?1, 'main', 'topic', '', '', ?2)`,
          )
          .run(i.value.id, repoId);
    }
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  // Signed out, which is how an unfurler arrives. Pages that send a visitor
  // to sign in (/map, /new, /board…) answer with a redirect, not a page.
  const pages = [
    "/",
    "/explore",
    "/signin",
    "/signup",
    "/audit",
    "/apps",
    "/contribute",
    "/search",
    "/family",
    "/recover",
    "/front",
    "/alice",
    "/alice/shown",
    "/alice/shown/issues/1",
    "/alice/shown/pulls/2",
  ];

  // A page about one thing shows that thing's card, not the forge's.
  const own: Record<string, string> = {
    "/audit": "/og/audit.png",
    "/alice/shown": "/og/repo/alice~shown.png",
    "/alice/shown/issues/1": "/og/issue/alice~shown~1.png",
    "/alice/shown/pulls/2": "/og/pull/alice~shown~2.png",
  };

  for (const path of pages) {
    test(`${path} carries og and twitter tags with a card that answers`, async () => {
      const res = await fetch(base + path, { redirect: "manual" });
      expect(res.status).toBe(200);
      const t = tags(await res.text());
      expect(t.get("og:title")).toBeTruthy();
      expect(t.get("og:description")).toBeTruthy();
      expect(t.get("twitter:card")).toBe("summary_large_image");
      const image = t.get("og:image")!;
      expect(image).toBeTruthy();
      expect(new URL(image).pathname).toBe(own[path] ?? "/og/site.png");
      const card = await fetch(base + new URL(image).pathname);
      expect(card.status).toBe(200);
      expect(card.headers.get("content-type")).toBe("image/png");
      await card.arrayBuffer();
    });
  }

  // A card an unfurler cannot fetch is never named: the site card stands in,
  // even when the page is viewed by a signed-in writer who can see the thing.
  for (const path of ["/alice/hidden/issues/1", "/alice/shown/issues/3", "/alice/shown/pulls/4"]) {
    test(`${path} falls back to the site card`, async () => {
      const res = await fetch(base + path, { headers: { cookie } });
      expect(res.status).toBe(200);
      const t = tags(await res.text());
      expect(new URL(t.get("og:image")!).pathname).toBe("/og/site.png");
      expect(t.get("twitter:card")).toBe("summary_large_image");
      const card = await fetch(base + "/og/site.png");
      expect(card.status).toBe(200);
      expect(card.headers.get("content-type")).toBe("image/png");
      await card.arrayBuffer();
    });
  }
});
