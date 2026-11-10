/**
 * A spawned forge whose owner has claimed it: the parent forge, one app,
 * one agent carried over, the child booted and served, the claim done.
 * Shared by the tests about a new forge's first page.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../../src/actions/spawn.ts";
import { createApp, type App } from "../../src/app.ts";
import { addCrew, createAgentRow } from "../../src/core/agents.ts";
import { createUser } from "../../src/core/users.ts";
import { commitFiles } from "../../src/git/write.ts";
import { repoDir } from "../../src/git/repos.ts";
import { serve } from "../../src/http/server.ts";
import { firstBoot } from "../../src/spawn/first-boot.ts";
import { hostedPlacement } from "../../src/spawn/placement.ts";
import { passkeyFields } from "./passkey.ts";
import { seatAs } from "./seat.ts";
import "./roomy-disk.ts";

export const PASSWORD = "a-long-next-steps-card-passphrase";
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run index.ts", health: "/" },
});

export type ClaimedForge = {
  /** The child forge's address. */
  base: string;
  /** The child forge itself, for tests that reach into its data. */
  child: App;
  /** The owner's session cookie, as `name=value`. */
  owner: string;
  /** Same-origin form POST to the child. */
  post: (cookie: string, path: string, form: Record<string, string>) => Promise<Response>;
  /** Stop both forges and remove their data. */
  stop: () => Promise<void>;
};

export async function claimedForge(prefix: string): Promise<ClaimedForge> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
    const parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    const alice = made.value;
    const repo = await createRepo(parent, alice, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [
        { path: "forge.json", content: FORGE_JSON },
        {
          path: "index.ts",
          content: "Bun.serve({fetch(){return new Response('hi')}})\n",
        },
      ],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    const atlas = await createUser(parent.db, {
      origin: "seed",
      username: "atlas",
      email: "atlas@a.invalid",
      agent: true,
    });
    if (!atlas.ok) throw new Error("agent");
    createAgentRow(parent.db, {
      userId: atlas.value.id,
      brief: "plan",
      createdBy: alice.id,
    });
    addCrew(parent.db, repo.value.id, atlas.value.id, alice.id);
    seatAs(parent.db, repo.value.id, atlas.value.id, "planner");
    const parentServers = await serve(parent);
    const spawned = await spawnForge(
      parent,
      alice,
      {
        name: "maria",
        org: "marias",
        apps: ["alice/bakery"],
        carryBriefs: true,
        carrySubscriptions: false,
        direction: "Run Maria's bakery.",
      },
      {
        catalog: [
          { ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 },
        ],
        briefs: [{ agent: "atlas", text: "plan" }],
        subscriptions: [],
      },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/x", {
          method: "POST",
          headers: { origin: "https://forge.test" },
        }),
        url: new URL("https://forge.test/x"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    const child = createApp({
      dataDir: childDirOf(parent, spawned.value.bodyId),
      port: 0,
    });
    await firstBoot(child);
    const servers = await serve(child);
    const link = spawned.value.claimUrl!;
    const token = link.split("/claim#")[1]!;
    const who = { token, username: "maria", email: "maria@bakery.test" };
    const claimed = await fetch(`${servers.url}/claim`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({
        ...who,
        ...(await passkeyFields(servers.url, "/claim/options", who)),
      }),
      redirect: "manual",
    });
    if (claimed.status !== 303) throw new Error(`claim ${claimed.status}`);
    const owner = (claimed.headers.get("set-cookie") ?? "").split(";")[0]!;
  return {
    base: servers.url,
    child,
    owner,
    post: (cookie, path, form) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: { cookie, origin: servers.url },
        body: new URLSearchParams(form),
        redirect: "manual",
      }),
    stop: async () => {
      servers.stop();
      child.close();
      parentServers.stop();
      parent.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
