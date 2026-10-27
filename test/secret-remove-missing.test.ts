/** Removing a secret that is not there is `no_such_secret`, changes nothing, and is only ever said to a forge admin (#7102). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { removeSecret } from "../src/actions/secrets.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createOrg } from "../src/core/orgs.ts";
import { listSecretNames, setSecret, type SecretScope } from "../src/core/secret_store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";

const MISSING = "NOT_THERE";
const KEPT = "KEPT_TOKEN";

let dataDir = "";
let app: App;
let admin: User, bob: User;
let scopes: { scope: SecretScope; ref: string; id: string }[] = [];

const names = (scope: SecretScope, id: string) => listSecretNames(app.db, scope, id).map((s) => s.name);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-secret-missing-"));
  app = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  admin = a.value;
  const b = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "correct-horse-battery",
  });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
  const org = createOrg(app.db, "acme", admin.id);
  if (!org.ok) throw new Error(org.error);
  const repo = await createRepo(app, admin, { name: "yard", visibility: "public" });
  if (!repo.ok) throw new Error(repo.error);
  scopes = [
    { scope: "forge", ref: "", id: "" },
    { scope: "org", ref: "acme", id: org.value.id },
    { scope: "repo", ref: `${admin.username}/yard`, id: repo.value.id },
  ];
  for (const s of scopes) {
    const set = setSecret(app.db, dataDir, s.scope, s.id, KEPT, "value-" + s.scope);
    if (!set.ok) throw new Error(set.error);
  }
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a forge admin removing an unknown name at every scope gets no_such_secret and loses nothing", () => {
  for (const s of scopes) {
    const r = removeSecret(app, admin, s.scope, s.ref, MISSING);
    expect(r).toEqual({ ok: false, error: "no_such_secret" });
    expect(names(s.scope, s.id)).toEqual([KEPT]);
  }
});

test("the same name at another scope is not removed", () => {
  for (const s of scopes) {
    const set = setSecret(app.db, dataDir, s.scope, s.id, "SHARED", "v");
    if (!set.ok) throw new Error(set.error);
  }
  const [forge, org, repo] = scopes as [(typeof scopes)[0], (typeof scopes)[0], (typeof scopes)[0]];
  expect(removeSecret(app, admin, "org", org.ref, "SHARED").ok).toBe(true);
  expect(names("org", org.id)).toEqual([KEPT]);
  expect(names("forge", forge.id)).toEqual([KEPT, "SHARED"]);
  expect(names("repo", repo.id)).toEqual([KEPT, "SHARED"]);
  // Gone at org now; removing it there again is a miss, and the others still stand.
  expect(removeSecret(app, admin, "org", org.ref, "SHARED")).toEqual({ ok: false, error: "no_such_secret" });
  expect(names("forge", forge.id)).toEqual([KEPT, "SHARED"]);
  expect(names("repo", repo.id)).toEqual([KEPT, "SHARED"]);
});

test("a non-admin and a signed-out caller get not_found, never no_such_secret", () => {
  for (const actor of [bob, undefined]) {
    for (const s of scopes) {
      for (const name of [MISSING, KEPT]) {
        expect(removeSecret(app, actor, s.scope, s.ref, name)).toEqual({ ok: false, error: "not_found" });
      }
      expect(names(s.scope, s.id)).toContain(KEPT);
    }
  }
});
