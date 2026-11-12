import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import { createOrg } from "../src/actions/orgs.ts";
import { createOrg as foundOrg } from "../src/core/orgs.ts";
import { updateProfile } from "../src/actions/users.ts";
import { reservedName, SYSTEM_NAMES, skeleton } from "../src/core/reserved.ts";
import {
  createUser,
  ensureEdgeUser,
  getUserByName,
} from "../src/core/users.ts";
import { isSafeName } from "../src/git/guard.ts";
import { buildRouter, serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

// A fresh outsider tries every way in with a name that is not theirs to take:
// an agent's, the owner's, a system name, or a page of the forge itself.
describe("reserved names", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reserved-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    base = servers.url;
    // The owner is the admin; the crew are agents.
    const owner = await seedAdmin(app, {
      username: "trevato",
      email: "owner@f.dev",
      password: "owner-passphrase",
    });
    if (!owner.ok) throw new Error(owner.error);
    for (const name of ["scout", "torque"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true,
        username: name,
        email: `${name}@agents.invalid`,
        agent: true,
        displayName: name === "scout" ? "Scout" : "Torque",
      });
      if (!made.ok) throw new Error(made.error);
    }
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const signup = (username: string) =>
    fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username.toLowerCase()}-${Math.random()}@outsider.test`,
        password: "outsider-passphrase",
      }),
    });

  test("a skeleton folds case, separators and look-alike digits", () => {
    expect(skeleton("Sc0ut")).toBe(skeleton("scout"));
    expect(skeleton("s.c-o_u.t")).toBe(skeleton("scout"));
    expect(skeleton("TREVAT0")).toBe(skeleton("trevato"));
    expect(skeleton("adm1n")).toBe(skeleton("admin"));
    expect(skeleton("ada")).not.toBe(skeleton("admin"));
  });

  test("signup refuses an agent's name (taken) and its look-alikes (reserved)", async () => {
    // The name itself belongs to the agent, so it is taken; a look-alike of
    // it is no one's, so it is reserved.
    for (const [name, error] of [
      ["scout", "username_taken"],
      ["Scout", "username_taken"],
      ["sc0ut", "username_reserved"],
      ["s-cout", "username_reserved"],
      ["torque", "username_taken"],
      ["T0RQUE", "username_reserved"],
    ] as const) {
      const res = await signup(name);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error });
      // No person account was made: the name still answers only to the agent.
      expect(getUserByName(app.db, name)?.kind ?? "none").not.toBe("user");
    }
  });

  test("signup refuses the owner's name (taken) and its look-alikes (reserved)", async () => {
    for (const [name, error] of [
      ["Trevato", "username_taken"],
      ["trevat0", "username_reserved"],
      ["tre-vato", "username_reserved"],
    ] as const) {
      const res = await signup(name);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error });
    }
  });

  test("signup refuses system names", async () => {
    for (const name of [
      "admin",
      "Administrator",
      "root",
      "plat",
      "forge",
      "support",
      "security",
      "noreply",
    ]) {
      const res = await signup(name);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "username_reserved" });
    }
  });

  test("signup refuses a name that is one of the forge's own pages", async () => {
    for (const name of ["settings", "signin", "apps", "map", "search", "api"]) {
      const res = await signup(name);
      expect(res.status).toBe(422);
    }
  });

  test("an ordinary name still signs up", async () => {
    const res = await signup("ada");
    expect(res.status).toBe(201);
    expect(getUserByName(app.db, "ada")?.kind).toBe("user");
  });

  test("the signup page says the name is reserved", async () => {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body: new URLSearchParams({
        username: "sc0ut",
        email: "page@outsider.test",
        password: "outsider-passphrase",
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That name is reserved.");
    expect(getUserByName(app.db, "sc0ut")).toBeUndefined();
  });

  test("the edge cannot bring in a reserved name", async () => {
    expect(ensureEdgeUser(app.db, "sc0ut")).toBeUndefined();
    expect(ensureEdgeUser(app.db, "admin")).toBeUndefined();
    expect(getUserByName(app.db, "sc0ut")).toBeUndefined();
    // An account that already exists still signs in by its own name.
    expect(ensureEdgeUser(app.db, "trevato")?.username).toBe(
      "trevato",
    );
  });

  test("an organization cannot take a reserved name", () => {
    // ada signed up over HTTP; founding an org needs a proven email first.
    proveAll(app);
    const ada = getUserByName(app.db, "ada")!;
    for (const [name, error] of [
      ["scout", "name_taken"],
      ["trevat0", "name_reserved"],
      ["security", "name_reserved"],
      ["settings", "name_reserved"],
    ] as const) {
      const made = createOrg(app, ada, name);
      expect(made.ok).toBe(false);
      if (!made.ok) expect(made.error).toBe(error);
    }
    expect(createOrg(app, ada, "ada-labs").ok).toBe(true);
  });

  test("a display name cannot impersonate the crew, the owner or the forge", () => {
    const ada = getUserByName(app.db, "ada")!;
    for (const displayName of [
      "Scout",
      "T0rque",
      "trevato",
      "Admin",
      "Forge",
    ]) {
      const patched = updateProfile(app, ada, { displayName });
      expect(patched.ok).toBe(false);
      if (!patched.ok) expect(patched.error).toBe("display_name_reserved");
    }
    expect(getUserByName(app.db, "ada")?.displayName).toBe("");
    expect(updateProfile(app, ada, { displayName: "Ada Lovelace" }).ok).toBe(
      true,
    );
  });

  test("look-alike letters from other scripts and accents fold to Latin", () => {
    const ada = getUserByName(app.db, "ada")!;
    for (const displayName of [
      "trеvato", // Cyrillic е
      "trevаto", // Cyrillic а
      "Ѕcout", // Cyrillic Ѕ
      "Sсout", // Cyrillic с
      "τorque", // Greek τ
      "Scουt", // Greek ο and υ
      "trevató", // an accent
      "tre\u0301vato", // a combining mark
      "Ꮪcout", // Cherokee Ꮪ
      "ＳＣＯＵＴ", // fullwidth
    ]) {
      const patched = updateProfile(app, ada, { displayName });
      expect(patched.ok).toBe(false);
      if (!patched.ok) expect(patched.error).toBe("display_name_reserved");
    }
  });

  test("a name mixing Latin with an unknown script is refused; one script is fine", () => {
    const ada = getUserByName(app.db, "ada")!;
    // Not in the fold table, so it cannot be judged: refused, not dropped.
    for (const displayName of ["scoutж", "Sc中out"]) {
      const patched = updateProfile(app, ada, { displayName });
      expect(patched.ok).toBe(false);
      // Refused for what it is, not as someone else's name.
      if (!patched.ok) expect(patched.error).toBe("display_name_mixed_script");
    }
    expect(updateProfile(app, ada, { displayName: "张伟" }).ok).toBe(true);
    expect(updateProfile(app, ada, { displayName: "José" }).ok).toBe(true);
  });

  test("Latin letters that do not decompose are letters, not a foreign script", () => {
    const ada = getUserByName(app.db, "ada")!;
    for (const displayName of ["Strauß", "Łukasz", "Søren", "Æsa", "Đorđe", "Þóra", "Bılal"]) {
      const patched = updateProfile(app, ada, { displayName });
      expect(patched.ok).toBe(true);
    }
    // …and they fold, so they cannot hide a protected name either.
    expect(updateProfile(app, ada, { displayName: "Scøut" }).ok).toBe(false);
  });

  test("a name that carries the owner's handle, or a crew name with a role, is refused", () => {
    const ada = getUserByName(app.db, "ada")!;
    for (const displayName of ["trevato (owner)", "Trevato official", "the real trevato", "Scout (crew)", "scout bot", "Torque · AI"]) {
      const patched = updateProfile(app, ada, { displayName });
      expect(patched.ok).toBe(false);
      if (!patched.ok) expect(patched.error).toBe("display_name_reserved");
    }
    // A crew name is also a word people have: alone beside other words it is fine.
    expect(updateProfile(app, ada, { displayName: "Scout Finch" }).ok).toBe(true);
  });

  test("a username that carries a protected name is refused at signup", async () => {
    for (const name of ["trevato-official", "scout-bot", "torque-crew"]) {
      const res = await signup(name);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "username_reserved" });
    }
    expect((await signup("scout-finch")).status).toBe(201);
  });

  test("a name run together with a protected one is refused too", async () => {
    // The owner's handle with digits, a doubled last letter, or a role word
    // run on; a crew name run together with a role word.
    for (const name of ["trevato2", "trevato007", "trevatoo", "trevatoofficial", "realtrevato", "scoutbot", "botscout", "torquecrew2"]) {
      const res = await signup(name);
      expect([name, res.status]).toEqual([name, 422]);
      expect(await res.json()).toMatchObject({ error: "username_reserved" });
    }
    const ada = getUserByName(app.db, "ada")!;
    for (const displayName of ["Trevato2", "ScoutBot", "trevatoo"]) {
      const patched = updateProfile(app, ada, { displayName });
      expect(patched.ok).toBe(false);
    }
    // A longer name that only contains a protected one is someone's own.
    for (const name of ["scouting", "torquemada", "scouts"])
      expect((await signup(name)).status).toBe(201);
  });

  test("an admin with a common first name leaves the longer names that contain it free", async () => {
    const maria = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "maria",
      email: "maria@f.dev",
      password: "a-good-passphrase",
    });
    if (!maria.ok) throw new Error(maria.error);
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(maria.value.id);
    try {
      for (const name of ["mariana", "annamaria", "rosemaria"])
        expect((await signup(name)).status).toBe(201);
      for (const name of ["realmaria", "maria2", "mariaa", "themaria", "mariaofficial"])
        expect((await signup(name)).status).toBe(422);
      // A display name is where real names live: only the handle itself, or
      // the handle with honorific words around it, is hers.
      const ada = getUserByName(app.db, "ada")!;
      for (const displayName of ["Maria Garcia", "Anna Maria", "Mariah Carey"])
        expect(updateProfile(app, ada, { displayName }).ok).toBe(true);
      for (const displayName of ["MARIA", "the real maria", "Maria official", "realmaria", "Maria (admin)", "Mariaa", "Mariaaa", "Maria Verified", "Maria (verified)", "Maria HQ"]) {
        const patched = updateProfile(app, ada, { displayName });
        expect([displayName, patched.ok]).toEqual([displayName, false]);
      }
    } finally {
      app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(maria.value.id);
    }
  });

  test("every way an account is made holds to the rule; a seed opts out by name", async () => {
    // A way in added later (a linked sign-in) makes accounts through
    // createUser, and inherits the rule without calling anything.
    const linked = await createUser(app.db, { origin: "seed", username: "sc0ut", email: "linked@outsider.test" });
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.error).toBe("username_reserved");
    const seeded = await createUser(app.db, {
      origin: "seed",
      username: "support",
      email: "support@f.dev",
      allowReserved: true,
    });
    expect(seeded.ok).toBe(true);
  });

  test("an organization is held where it is made (#720): the API refuses, and a seed opts out by name", async () => {
    const ada = getUserByName(app.db, "ada")!;
    // The core that makes orgs holds the rule itself, so a caller that
    // forgets to ask (a spawned forge, an import) cannot found one.
    const bare = foundOrg(app.db, "sc0ut-crew", ada.id);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toBe("name_reserved");
    expect(foundOrg(app.db, "security", ada.id, { allowReserved: true }).ok).toBe(true);
    // The API door, as a signed-in person.
    const signin = await fetch(`${base}/signin`, {
      method: "POST",
      headers: { origin: base },
      body: new URLSearchParams({ username: "ada", password: "outsider-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("=");
    for (const name of ["trevat0", "scout-bot", "settings"]) {
      const res = await fetch(`${base}/api/v1/orgs`, {
        method: "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(`${name} ${res.status}`).toBe(`${name} 422`);
      expect(getUserByName(app.db, name)).toBeUndefined();
    }
  });

  test("a display name is judged as it is stored, after the cut", () => {
    const ada = getUserByName(app.db, "ada")!;
    const padded = `trevato${" ".repeat(75)}x`;
    const patched = updateProfile(app, ada, { displayName: padded });
    expect(patched.ok).toBe(false);
    expect(getUserByName(app.db, "ada")?.displayName).not.toBe("trevato");
  });

  test("the forge's own nouns are reserved too", async () => {
    for (const name of ["users", "orgs", "repos", "git", "ssh", "status", "docs", "open-platform", "asked"]) {
      const res = await signup(name);
      expect(res.status).toBe(422);
    }
  });

  test("the owner may keep their own name as a display name", () => {
    const owner = getUserByName(app.db, "trevato")!;
    expect(updateProfile(app, owner, { displayName: "Trevato" }).ok).toBe(true);
  });

  test("an existing account is never locked out by a later reservation", () => {
    // `plat` here is a system name; an account that already holds a name
    // keeps it, and only new claims are refused.
    expect(reservedName(app.db, "ada")).toBeUndefined();
    expect(reservedName(app.db, "plat")).toBe("system");
  });

  test("every top-level page of the forge is a reserved name", () => {
    // Only a head that could be a username can collide with a profile.
    const heads = buildRouter().literalHeads().filter(isSafeName);
    expect(heads.length).toBeGreaterThan(10);
    const system = new Set(SYSTEM_NAMES.map(skeleton));
    const missing = heads.filter((head) => !system.has(skeleton(head)));
    expect(missing).toEqual([]);
  });
});
