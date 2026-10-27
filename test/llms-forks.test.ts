/** llms.txt folds public forks under their root, counting only what a stranger can see. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { createRepo, forkRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { forgetListings } from "../src/core/listings.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

test("one line with the visible forks counted; a fork of a hidden root stands alone and names no root", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-llms-forks-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    const person = async (username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      promote(app.db, made.value);
      return made.value;
    };
    const admin = await person("olive", true);
    const alice = await person("alice");
    const sam = await person("sam");
    const forkers = [await person("f1"), await person("f2"), await person("f3"), await person("f4")];
    const make = async (who: typeof alice, name: string) => {
      const r = await createRepo(app, who, { name, visibility: "public" });
      if (!r.ok) throw new Error(String(r.error));
    };
    await make(alice, "root");
    await make(sam, "tools");
    const fork = async (who: typeof alice, from: string) => {
      const [o, n] = from.split("/");
      const r = await forkRepo(app, who, getRepo(app.db, o!, n!)!);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return r.value;
    };
    for (const f of forkers.slice(0, 3)) await fork(f, "alice/root");
    const hidden = await fork(forkers[3]!, "alice/root");
    const priv = await updateRepoSettings(app, forkers[3]!, getRepo(app.db, "f4", "root")!, { visibility: "private" });
    expect(priv.ok).toBe(true);
    void hidden;
    const rita = await person("rita");
    await fork(rita, "sam/tools");
    expect((await suspendAccount(app, admin, "sam")).ok).toBe(true);
    forgetListings(app.db);

    const body = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
    const section = body.slice(body.indexOf("## Public repositories"));
    expect(section).toContain(`- [alice/root](${servers.url}/alice/root) · 3 forks\n`);
    expect(section).not.toContain("f1/root");
    expect(section).not.toContain("f4/root");
    expect(section).toContain("- [rita/tools]");
    expect(section).not.toContain("sam/tools");
    expect(section).not.toContain("sam");
  } finally {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the section is capped at 50 lines and ends with the explore link", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-llms-cap-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    for (let i = 0; i < 52; i++) {
      const r = await createRepo(app, made.value, { name: `r${i}`, visibility: "public" });
      if (!r.ok) throw new Error(String(r.error));
    }
    const body = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
    const section = body.slice(body.indexOf("## Public repositories"));
    expect(section.match(/^- \[alice\//gm)?.length).toBe(50);
    expect(section).toContain(`- More: ${servers.url}/api/v1/explore\n`);
  } finally {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
