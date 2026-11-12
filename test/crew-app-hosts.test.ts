/**
 * A crew run on repository R may reach R's own app — production and every
 * open pull's preview — and no other repository's app (`crew/app_hosts.ts`).
 * The hosts are exact: R's slug and R's pull numbers, so `arm--3` (R's
 * preview) is allowed and the app `armory`, or another repo's preview, is
 * not. The brief names the URLs the shell may reach.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { ownApp, ownAppUrls } from "../src/crew/app_hosts.ts";
import { ownAppLines } from "../src/crew/brief.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";
import { STANDARD, type Machine } from "../src/crew/machines.ts";
import { shellCell, shellReach } from "../src/machines/shell.ts";

const DOMAIN = "--forge-trevato-apps.open-platform.sh";

describe("a crew run's own app hosts", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let arm: Repo;
  let other: Repo;
  let plain: Repo;
  let pullNumber: number;

  async function pullOn(repo: Repo, branch: string): Promise<number> {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: repo.defaultBranch,
      message: "a change",
      files: [{ path: `${branch}.md`, content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: branch,
      baseBranch: repo.defaultBranch,
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value.number;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-hosts-"));
    app = createForge({ dataDir, port: 0 });
    new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "https",
      forgeUrl: "https://forge.open-platform.sh",
    });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const repo = async (name: string) => {
      const r = await createRepo(app, alice, { name });
      if (!r.ok) throw new Error(String(r.error));
      await commitToBranch(app, alice, r.value, {
        branch: r.value.defaultBranch,
        message: "init",
        files: [{ path: "README.md", content: "hi\n" }],
      });
      return r.value;
    };
    arm = await repo("arm");
    other = await repo("armory");
    plain = await repo("plain");
    for (const r of [arm, other]) {
      const record = createApp(app.db, {
        repoId: r.id,
        slug: r.name,
        access: "public",
      });
      if (!record.ok) throw new Error(record.error);
    }
    pullNumber = await pullOn(arm, "feature");
    await pullOn(other, "theirs");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists production and each open pull's preview of the run's own repository", () => {
    expect(ownApp(app, arm)).toEqual({
      access: "public",
      production: `https://arm${DOMAIN}`,
      previews: [{ number: pullNumber, url: `https://arm--${pullNumber}${DOMAIN}` }],
    });
  });

  test("a repository that is not an app has none", () => {
    expect(ownApp(app, plain)).toBeUndefined();
    expect(ownAppUrls(undefined)).toEqual([]);
  });

  test("a run on R may fetch R's preview and production, and no other repository's app", () => {
    const hosts = sandboxPolicy({
      dataDir,
      agentName: "torque",
      urls: ["https://forge.open-platform.sh"],
      appUrls: ownAppUrls(ownApp(app, arm)),
    }).allowHosts;
    expect(hosts).toContain(`arm${DOMAIN}`);
    expect(hosts).toContain(`arm--${pullNumber}${DOMAIN}`);
    expect(hosts).not.toContain(`armory${DOMAIN}`);
    expect(hosts.some((h) => h.startsWith("armory"))).toBe(false);
    expect(hosts.some((h) => h.includes("*"))).toBe(false);
  });

  test("an app on loopback is allowed by host and port, never every port", () => {
    const hosts = sandboxPolicy({
      dataDir,
      agentName: "torque",
      urls: ["http://localhost:3000"],
      appUrls: ["http://arm.localhost:3000", "not a url"],
    }).allowHosts;
    expect(hosts).toContain("arm.localhost:3000");
    expect(hosts).not.toContain("arm.localhost");
  });

  test("the brief names the URLs the shell may reach", () => {
    const [line] = ownAppLines(ownApp(app, arm));
    expect(line).toContain(`production at https://arm${DOMAIN}`);
    expect(line).toContain(`#${pullNumber} at https://arm--${pullNumber}${DOMAIN}`);
    expect(line).not.toContain("armory");
    expect(ownAppLines(undefined)).toEqual([]);
    expect(
      ownAppLines({ access: "public", production: "https://x.example", previews: [] })[0],
    ).toContain("no pull has a preview yet");
    expect(ownAppLines({ access: "public", production: "https://x.example", previews: [] })).toHaveLength(1);
    const [, door] = ownAppLines({ access: "private", production: "https://x.example", previews: [] });
    expect(door).toContain("This app is private");
    expect(door).toContain("404 by design");
    expect(door).toContain("Bearer $FORGE_TOKEN");
  });

  describe("a writer's shell (#9934)", () => {
    const machine = (reach: Machine["reach"]): Machine => ({
      name: "box",
      label: "box",
      tools: [],
      reach,
    });
    const FORGE = "https://forge.open-platform.sh";

    test("a machine with `apps` reach opens R's production and previews, exactly, and no other repository's", () => {
      const spec = shellCell(app, join(dataDir, "w"), machine(["apps"]), "machine:x/box", ownAppUrls(ownApp(app, arm)));
      const forge = app.config.url === undefined ? [] : [app.config.url];
      expect(spec.reach).toEqual([...forge, `https://arm${DOMAIN}`, `https://arm--${pullNumber}${DOMAIN}`]);
      expect(spec.reach.some((u) => u.includes("armory"))).toBe(false);
      expect(spec.egress).toEqual([]);
      // The forge's own data stays hidden whatever the machine says.
      expect(spec.hide).toContain(app.config.dataDir);
    });

    test("a machine with no reach opens the forge alone", () => {
      const urls = ownAppUrls(ownApp(app, arm));
      expect(shellReach(FORGE, machine([]), urls)).toEqual([FORGE]);
      const spec = shellCell(app, join(dataDir, "w"), machine([]), "machine:x/box", urls);
      expect(spec.reach.some((u) => u.includes(DOMAIN))).toBe(false);
    });

    test("the reach follows what the machine declares, `standard` included", () => {
      const urls = ownAppUrls(ownApp(app, arm));
      expect(shellReach(FORGE, STANDARD, urls)).toEqual([FORGE, ...urls]);
      expect(shellReach(undefined, machine(["apps"]), [])).toEqual([]);
    });
  });
});
