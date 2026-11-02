/** A look's feed post names the pull it previews, links to it, and shows its thumbnail at a fixed size (#5809). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { feedCard, FEED_PICTURE, picturesFor } from "../src/web/studio/feed.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PULL_OID = "b".repeat(40);
const PROD_OID = "c".repeat(40);
let root = "";
let app: App;
let alice: User;
let repoId = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-feed-look-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  proveAll(app);
  const made = await createRepo(app, alice, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  repoId = made.value.id;
  const record = insertApp(app.db, { repoId, slug: "garden", access: "public" });
  if (!record.ok) throw new Error(record.error);
  for (const [env, oid] of [["pull-5736", PULL_OID], ["production", PROD_OID]] as const) {
    const path = `looks/${record.value.id}/${env}/${oid}-thumb.png`;
    mkdirSync(join(root, "looks", record.value.id, env), { recursive: true });
    writeFileSync(join(root, path), "png");
    recordLook(app.db, { appId: record.value.id, env, commitOid: oid, kind: "thumb", path, takenAs: "nobody" });
    app.bus.append({ kind: "look.taken", repoId, payload: { env, commitOid: oid } });
  }
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const posts = () => {
  const items = readFeed(app.db, alice, { limit: 20 }).items.filter((i) => i.kind === "look");
  const ctx = { app, auth: { user: alice } } as never;
  const pictures = picturesFor(ctx, items);
  return items.map((i) => ({ item: i, text: feedCard(i, new Map(), pictures.get(i.id)).text }));
};

test("a pull's look names the pull, links to it and shows a fixed-size lazy thumbnail", () => {
  const post = posts().find((p) => p.item.what === "a new picture of #5736");
  expect(post).toBeDefined();
  expect(post!.item.link).toBe("/alice/forge/pulls/5736");
  expect(post!.text).toContain('href="/alice/forge/pulls/5736"');
  expect(post!.text).toContain(`/alice/forge/looks/pull-5736/${PULL_OID}/thumb.png?v=`);
  expect(post!.text).toContain(`width="${FEED_PICTURE.width}" height="${FEED_PICTURE.height}"`);
  expect(post!.text).toContain('loading="lazy"');
});

test("a look of production says production", () => {
  const post = posts().find((p) => p.item.what === "a new picture of production");
  expect(post).toBeDefined();
  expect(post!.item.link).toBe("/alice/forge");
  expect(post!.text).toContain(`/looks/production/${PROD_OID}/thumb.png`);
});
