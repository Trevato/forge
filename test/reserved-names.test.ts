import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/actions/orgs.ts";
import { signUp, updateProfile } from "../src/actions/users.ts";
import { reservedName, SYSTEM_NAMES, skeleton } from "../src/core/reserved.ts";
import {
  createUser,
  ensureEdgeUser,
  getUserByName,
} from "../src/core/users.ts";
import { isSafeName } from "../src/git/guard.ts";
import { buildRouter, serve, type Servers } from "../src/http/server.ts";

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
    base = servers.url;
    // The owner is the first account; the crew are agents.
    const owner = await signUp(app, {
      username: "trevato",
      email: "owner@f.dev",
      password: "owner-passphrase",
    });
    if (!owner.ok) throw new Error(owner.error);
    for (const name of ["scout", "torque"]) {
      const made = await createUser(app.db, {
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

  test("signup refuses an agent's name and its look-alikes", async () => {
    for (const name of [
      "scout",
      "Scout",
      "sc0ut",
      "s-cout",
      "torque",
      "T0RQUE",
    ]) {
      const res = await signup(name);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "username_reserved" });
      // No person account was made: the name still answers only to the agent.
      expect(getUserByName(app.db, name)?.kind ?? "none").not.toBe("user");
    }
  });

  test("signup refuses the owner's name and its look-alikes", async () => {
    for (const name of ["Trevato", "trevat0", "tre-vato"]) {
      const res = await signup(name);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "username_reserved" });
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
      expect(await res.json()).toEqual({ error: "username_reserved" });
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
    expect(await ensureEdgeUser(app.db, "sc0ut", "f.dev")).toBeUndefined();
    expect(await ensureEdgeUser(app.db, "admin", "f.dev")).toBeUndefined();
    expect(getUserByName(app.db, "sc0ut")).toBeUndefined();
    // An account that already exists still signs in by its own name.
    expect((await ensureEdgeUser(app.db, "trevato", "f.dev"))?.username).toBe(
      "trevato",
    );
  });

  test("an organization cannot take a reserved name", () => {
    const ada = getUserByName(app.db, "ada")!;
    for (const name of ["scout", "trevat0", "security", "settings"]) {
      const made = createOrg(app, ada, name);
      expect(made.ok).toBe(false);
      if (!made.ok) expect(made.error).toBe("name_reserved");
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
    expect(updateProfile(app, ada, { displayName: "scoutж" }).ok).toBe(false);
    expect(updateProfile(app, ada, { displayName: "Sc中out" }).ok).toBe(false);
    expect(updateProfile(app, ada, { displayName: "张伟" }).ok).toBe(true);
    expect(updateProfile(app, ada, { displayName: "José" }).ok).toBe(true);
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
