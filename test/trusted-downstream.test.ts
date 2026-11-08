/**
 * A trusted downstream forge's proposals run and fold in like a trusted
 * origin's (#9451): by date, behind the same stop switch, and only for the
 * pair (forge, child name) a writer trusted.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { proposedByText, pullProposalOf, recordPullProposal } from "../src/core/proposal_token.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { foldWall } from "../src/crew/fold_walls.ts";
import { foldsIn, needsCrewReview, recordPullSource, resumeFoldIn, stopFoldIn, trustSource, untrust } from "../src/core/trusted_sources.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let lib: Repo;
let baseOid: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-downstream-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
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
  const repo = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  lib = repo.value;
  const base = await commitToBranch(app, alice, lib, { message: "Start", files: [{ path: "README.md", content: "hi\n" }] });
  if (!base.ok) throw new Error(JSON.stringify(base.error));
  baseOid = base.value.commitOid;
}, 120_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const propose = async (child: string, origin: string, file = `docs/${child}.md`) => {
  const branch = `child/${child}/work`;
  const done = await commitToBranch(app, alice, lib, {
    branch,
    message: "work",
    files: [{ path: file, content: "x\n" }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const opened = await openPull(app, alice, lib, { title: `From ${child}`, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  recordPullProposal(app.db, opened.value.id, { child, origin });
  return { pull: () => getPull(app.db, lib.id, opened.value.number)!, head: done.value.commitOid };
};

test("a child's proposal waits until its forge and name are trusted, then runs; the stop switch and a lapse end it", async () => {
  const { pull, head } = await propose("kid", "https://kid.example.com/");
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);

  // A different name or a different forge is a stranger.
  const other = trustSource(app.db, { host: "kid.example.com", account: "child:other", until: "2099-01-01", setBy: alice.id });
  if (typeof other === "string") throw new Error(other);
  trustSource(app.db, { host: "evil.example.com", account: "child:kid", until: "2099-01-01", setBy: alice.id });
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);

  const kid = trustSource(app.db, { host: "kid.example.com", account: "child:kid", until: "2099-01-01", setBy: alice.id });
  if (typeof kid === "string") throw new Error(kid);
  expect(foldsIn(app.db, pull().id)).toBe(true);
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(true);

  stopFoldIn(app.db, alice.id);
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);
  resumeFoldIn(app.db);
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(true);

  expect(foldsIn(app.db, pull().id, new Date("2100-01-01"))).toBe(false);
  untrust(app.db, kid.id);
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);
});

test("an origin account never trusts a child of the same name, nor the reverse", async () => {
  const { pull, head } = await propose("twin", "https://twin.example.com/");
  // The origin's account `twin` on that very host is a person there, not the forge peer.
  const person = trustSource(app.db, { host: "twin.example.com", account: "twin", until: "2099-01-01", setBy: alice.id });
  if (typeof person === "string") throw new Error(person);
  expect(foldsIn(app.db, pull().id)).toBe(false);
  expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);

  // And trusting the child does not trust that person's pull from the origin.
  untrust(app.db, person.id);
  const child = trustSource(app.db, { host: "twin.example.com", account: "child:twin", until: "2099-01-01", setBy: alice.id });
  if (typeof child === "string") throw new Error(child);
  expect(foldsIn(app.db, pull().id)).toBe(true);
  const originPull = await propose("plain", "https://plain.example.com/");
  recordPullSource(app.db, { pullId: originPull.pull().id, host: "twin.example.com", account: "twin", via: [] });
  app.db.query("DELETE FROM pull_proposal WHERE issue_id = ?1").run(originPull.pull().id);
  expect(foldsIn(app.db, originPull.pull().id)).toBe(false);

  // The prefix is not a way to name an origin account, and a bad child name is refused.
  expect(trustSource(app.db, { host: "x.example.com", account: "child:", until: "2099-01-01", setBy: alice.id })).toBe("bad_account");
  expect(trustSource(app.db, { host: "x.example.com", account: "child:a b", until: "2099-01-01", setBy: alice.id })).toBe("bad_account");
});

test("a trusted child's pull meets the same walls, and the page line says why it ran", async () => {
  trustSource(app.db, { host: "wall.example.com", account: "child:wall", until: "2099-01-01", setBy: alice.id });
  const calm = await propose("wall", "https://wall.example.com/", "docs/calm.md");
  expect(foldsIn(app.db, calm.pull().id)).toBe(true);
  expect(needsCrewReview(app.db, calm.pull().id)).toBe(false);
  expect(await foldWall(app, lib, calm.pull(), baseOid)).toEqual([]);
  expect(proposedByText(pullProposalOf(app.db, calm.pull().id)!)).toContain("trusted as child:wall");

  // Same trust, but the diff touches a secret: a person decides.
  trustSource(app.db, { host: "wall2.example.com", account: "child:wall2", until: "2099-01-01", setBy: alice.id });
  const risky = await propose("wall2", "https://wall2.example.com/", ".env");
  expect(foldsIn(app.db, risky.pull().id)).toBe(true);
  const walls = await foldWall(app, lib, risky.pull(), baseOid);
  expect(walls.join(" ")).toContain("secrets or credentials");

  // A stranger's proposal says nothing of trust.
  const stranger = await propose("stranger", "https://stranger.example.com/");
  expect(proposedByText(pullProposalOf(app.db, stranger.pull().id)!)).not.toContain("trusted");
});
