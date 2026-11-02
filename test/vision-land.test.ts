/**
 * Landing a vision pull (#5834): an admin's merge regenerates the fenced
 * block of the direction and nothing else; anyone else's merge leaves it and
 * the pull page says so in the forge's own line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listEvents } from "../src/core/events.ts";
import { getOrg } from "../src/core/orgs.ts";
import { savePlacement } from "../src/core/placements.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { BLOCK_END, BLOCK_START, DIRECTION_LIMIT, withVisionBlock } from "../src/crew/vision.ts";
import { parseVision } from "../src/core/vision.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";

const MD = `# Vision

The forge is a social place for building.

## Order of work
0. **Trust, always first.** Agents are contained.
1. **One front door: the feed.** Home is a timeline.

## How we build
- A deterministic tool with deliberate noise: actions are explicit.
- Done means reachable.
`;
const vision = parseVision(MD);

describe("withVisionBlock", () => {
  test("appends after the owner's words, then regenerates in place, byte for byte outside", () => {
    const first = withVisionBlock("Mine, first.", vision);
    if (!first.ok) throw new Error(first.why);
    expect(first.text.startsWith("Mine, first.\n\n" + BLOCK_START)).toBe(true);
    expect(first.text).toContain("Order of work: 0. Trust, always first; 1. One front door: the feed.");
    const wrapped = `before é\n${first.text.slice("Mine, first.\n\n".length)}\n  after  `;
    const again = withVisionBlock(wrapped, parseVision(MD.replace("Done means reachable.", "Done means seen.")));
    if (!again.ok) throw new Error(again.why);
    expect(again.text.startsWith("before é\n" + BLOCK_START)).toBe(true);
    expect(again.text.endsWith(BLOCK_END + "\n  after  ")).toBe(true);
    expect(again.text).toContain("Rule: Done means seen.");
  });
  test("an orphan start marker changes nothing", () => {
    const r = withVisionBlock(`mine\n${BLOCK_START}\nhalf`, vision);
    expect(r.ok).toBe(false);
  });
  test("an end marker before the start changes nothing", () => {
    expect(withVisionBlock(`${BLOCK_END} ${BLOCK_START}`, vision).ok).toBe(false);
  });
  test("the whole direction stays under 2,000 characters", () => {
    const long = parseVision(`# V\n\n${"word ".repeat(1000)}\n\n## How we build\n${"- rule ".repeat(10).split(" - ").map((_, i) => `- ${"r".repeat(300)}${i}`).join("\n")}\n`);
    const r = withVisionBlock("x".repeat(1500), long);
    if (!r.ok) throw new Error(r.why);
    expect(r.text.length).toBeLessThanOrEqual(DIRECTION_LIMIT);
    expect(r.text.startsWith("x".repeat(1500))).toBe(true);
    expect(withVisionBlock("x".repeat(1990), long).ok).toBe(false);
  });
});

describe("landing a vision pull", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: User;
  let bob: User;
  let repo: Repo;
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vision-land-"));
    app = createApp({ dataDir, port: 0 });
    const made = await Promise.all(
      ["alice", "bob"].map((username) => signUp(app, { username, email: `${username}@forge.test`, password: "a-long-passphrase" })),
    );
    if (!made.every((m) => m.ok)) throw new Error("sign-up failed");
    [owner, bob] = made.map((m) => (m.ok ? m.value : undefined!)) as [User, User];
    promote(app.db, owner, bob);
    expect(createOrg(app, owner, "acme").ok).toBe(true);
    const acme = getOrg(app.db, "acme")!;
    const devs = createTeam(app, owner, acme, "devs", "write");
    if (!devs.ok) throw new Error("team");
    expect(addTeamMember(app, owner, acme, devs.value, "bob").ok).toBe(true);
    const r = await createRepo(app, owner, { owner: "acme", name: "site", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    expect((await commitToBranch(app, owner, repo, { message: "seed", files: [{ path: "docs/VISION.md", content: MD }] })).ok).toBe(true);
    servers = await serve(app);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const direction = (): string => getRepoById(app.db, repo.id)!.autonomyDirection;
  const setDirection = (text: string): void => {
    updateRepoSettings(app.db, getRepoById(app.db, repo.id)!, { autonomyDirection: text });
  };

  /** A pull that changes VISION.md; marked as a vision pull by its placement unless `marked` is false. */
  async function visionPull(marked: boolean, branch = `vision-${++n}`) {
    const md = MD.replace("Done means reachable.", `Done means reachable ${n}.`);
    expect((await commitToBranch(app, owner, repo, { branch, message: "v", files: [{ path: "docs/VISION.md", content: md }] })).ok).toBe(true);
    const pull = await openPull(app, owner, repo, { title: "Note a change of direction", body: "", baseBranch: "main", headBranch: branch });
    if (!pull.ok) throw new Error(String(pull.error));
    if (marked)
      savePlacement(app.db, {
        thoughtId: `th${n}`, kind: "vision", reply: "", asked: false, decidedBy: "t", placedAt: new Date().toISOString(),
        placed: [{ action: "proposed", repo: "acme/site", number: pull.value.number, pull: pull.value.number }],
      });
    return pull.value;
  }

  test("an admin's merge writes the block, keeps the owner's words either side, and says so in settings_updated", async () => {
    setDirection(`Ship small.\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\nNever page me.`);
    const pull = await visionPull(true);
    expect((await mergePull(app, owner, repo, pull, "squash")).ok).toBe(true);
    const text = direction();
    expect(text.startsWith(`Ship small.\n\n${BLOCK_START}\nPurpose: The forge is a social place`)).toBe(true);
    expect(text.endsWith(`${BLOCK_END}\n\nNever page me.`)).toBe(true);
    expect(text).toContain(`Done means reachable ${n}.`);
    expect(text.length).toBeLessThanOrEqual(DIRECTION_LIMIT);
    const e = listEvents(app.db, { repoId: repo.id, kind: "repo.settings_updated", limit: 1 })[0]!;
    expect(e.payload["changed"]).toEqual({
      autonomyDirection: { from: `Ship small.\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\nNever page me.`, to: text },
    });
    expect(e.actorId).toBe(owner.id);
  });

  test("a branch named vision-… is not a vision pull", async () => {
    setDirection("mine");
    const pull = await visionPull(false);
    expect((await mergePull(app, owner, repo, pull, "squash")).ok).toBe(true);
    expect(direction()).toBe("mine");
  });

  test("an orphan start marker leaves the direction unchanged", async () => {
    const orphan = `mine\n${BLOCK_START}\nunfinished`;
    setDirection(orphan);
    const pull = await visionPull(true);
    expect((await mergePull(app, owner, repo, pull, "squash")).ok).toBe(true);
    expect(direction()).toBe(orphan);
  });

  test("a writer's merge leaves the direction, comments nobody, and the pull page shows the forge's line", async () => {
    setDirection("mine");
    const pull = await visionPull(true);
    const comments = app.db.query<{ c: number }, []>("SELECT count(*) AS c FROM comment").get()!.c;
    expect((await mergePull(app, bob, repo, pull, "squash")).ok).toBe(true);
    expect(direction()).toBe("mine");
    expect(app.db.query<{ c: number }, []>("SELECT count(*) AS c FROM comment").get()!.c).toBe(comments);
    const e = listEvents(app.db, { repoId: repo.id, kind: "repo.vision_kept", limit: 1 })[0]!;
    expect(e.payload["pull"]).toBe(pull.number);
    expect(e.actorId).toBeNull();
    const html = await (await fetch(`${servers.url}/acme/site/pulls/${pull.number}`)).text();
    expect(html).toContain("the forge kept the repository's direction as it was: only an admin&#39;s merge rewrites it");
  });
});

describe("showing the direction (#5835)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: User;
  let repo: Repo;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vision-show-"));
    app = createApp({ dataDir, port: 0 });
    const made = await signUp(app, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!made.ok) throw new Error("sign-up failed");
    owner = made.value;
    promote(app.db, owner);
    const r = await createRepo(app, owner, { owner: "alice", name: "site", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    expect((await commitToBranch(app, owner, repo, { message: "seed", files: [{ path: "docs/VISION.md", content: MD }] })).ok).toBe(true);
    servers = await serve(app);
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-long-passphrase" }),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = async (path: string): Promise<string> => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

  test("settings marks the fenced block as following the vision and the rest as the owner's", async () => {
    updateRepoSettings(app.db, getRepoById(app.db, repo.id)!, {
      autonomyDirection: `Ship small.\n\n${BLOCK_START}\nRule: Done means reachable.\n${BLOCK_END}\n\nNever page me.`,
    });
    const page = await get("/alice/site/settings/crew");
    const marked = page.slice(page.indexOf('id="direction-marked"'));
    expect(marked).toMatch(/data-direction-part="owner"[\s\S]*Ship small\./);
    expect(marked).toMatch(/data-direction-part="vision"[\s\S]*follows docs\/VISION\.md[\s\S]*Rule: Done means reachable\./);
    expect(marked).toMatch(/data-direction-part="owner"[\s\S]*Never page me\./);
    expect((marked.match(/follows docs\/VISION\.md/g) ?? []).length).toBe(1);
  });

  test("a vision pull shows today's block beside the one the merge writes, and the merge writes exactly that", async () => {
    updateRepoSettings(app.db, getRepoById(app.db, repo.id)!, { autonomyDirection: "Mine.\n\nOld block text." });
    const md = MD.replace("Done means reachable.", "Done means shown first.");
    expect((await commitToBranch(app, owner, repo, { branch: "vision-x", message: "v", files: [{ path: "docs/VISION.md", content: md }] })).ok).toBe(true);
    const pull = await openPull(app, owner, repo, { title: "Note a change of direction", body: "", baseBranch: "main", headBranch: "vision-x" });
    if (!pull.ok) throw new Error(String(pull.error));
    const plain = await get(`/alice/site/pulls/${pull.value.number}`);
    expect(plain).not.toContain("direction-preview");
    savePlacement(app.db, {
      thoughtId: "thshow", kind: "vision", reply: "", asked: false, decidedBy: "t", placedAt: new Date().toISOString(),
      placed: [{ action: "proposed", repo: "alice/site", number: pull.value.number, pull: pull.value.number }],
    });
    const page = await get(`/alice/site/pulls/${pull.value.number}`);
    const card = page.slice(page.indexOf('id="direction-preview"'));
    expect(card).toMatch(/data-direction="today"[\s\S]*Old block text\./);
    expect(card).toMatch(/data-direction="after"[\s\S]*follows docs\/VISION\.md[\s\S]*Rule: Done means shown first\./);
    const expected = withVisionBlock("Mine.\n\nOld block text.", parseVision(md));
    if (!expected.ok) throw new Error(expected.why);
    expect((await mergePull(app, owner, repo, pull.value, "squash")).ok).toBe(true);
    expect(getRepoById(app.db, repo.id)!.autonomyDirection).toBe(expected.text);
    expect(await get(`/alice/site/pulls/${pull.value.number}`)).not.toContain('id="direction-preview"');
  });
});
