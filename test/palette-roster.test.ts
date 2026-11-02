import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let admin: User;
let member: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});
const roster = (user?: User) =>
  forgeCommands(new Session(app, identity(user)))({} as never).map((c) => [c.id, c.title, c.hint]);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-palette-roster-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const mk = async (username: string, isAdmin: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", isAdmin,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  admin = await mk("alice", true);
  member = await mk("bob", false);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

// The palette's entries as main has them: id, title, hint, in order, for each kind of session.
test("a site-admin person is offered the whole roster", () => {
  expect(roster(admin)).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["profile", "Open a profile", "username or org"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["new-org", "New organization", "an organization you own, for a client's apps"],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["notify", "Phone notifications", "where the crew reaches your phone; s sets, x turns off"],
    ["ssh-keys", "SSH keys", "list, add and remove the keys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["sentinel", "Sentinel", "the forge's open faults"],
    ["boards", "Boards", "the forge's boards and their panels"],
    ["origin-apps", "Origin apps", "your OAuth apps for connecting origins; a adds, d removes"],
    ["system-memory", "System memory", "RSS beside the JS heap, hourly for 24 h"],
    ["flow", "Flow", "the pipeline's bottleneck and throughput"],
    ["system", "System", "the machine now: CPU, memory, disks, processes"],
    ["telemetry", "Telemetry", "which agents may read flow and system; enter flips the grant"],
    ["capacity", "Capacity", "concurrency and guards, live; e changes a settable one"],
    ["resilience", "Resilience", "where snapshots go and the mirror; each protection green, red or untested"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["releases", "Releases", "the live release and the kept ones"],
    ["keeper", "Release keeper", "what holds the next cut, and each release it cut with its probes"],
    ["stalled", "Stalled steps", "pulls whose check is red or was never asked for; enter re-runs"],
    ["file-holds", "Held files", "hold new work on a file, release it, or list the holds"],
    ["access", "Access", "what outside agents tried"],
    ["flags", "Flags", "declared flags and their live values"],
    ["secrets", "Secrets", "sealed secrets by name; set or remove one"],
    ["trusted-hosts", "Trusted hosts", "internal hosts an origin may reach"],
    ["usage", "Usage", "every route, unused ones first"],
    ["crew-scorecard", "Crew scorecard", "agent runs per model and per prompt version"],
    ["crew-handover", "Crew hand-overs", "issues parked twice, and the last restore drill"],
    ["scorecard", "Crew scorecard per agent", "each agent's pulls landed, review rounds, red checks, reverts, time to land"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["model", "Model budget", "what your crew may spend, and add your own subscription"],
    ["model-grant", "Model grant", "give an account dollars a month, or take it back"],
    ["model-ceiling", "Model ceiling", "set an account's dollars a day and a run"],
    ["can", "What I can do", "your role and what it allows here"],
    ["people", "People", "who is a guest, a member or an admin; promote or demote"],
    ["quotas", "Account quotas", "what one account may own, and who changed it"],
    ["limits", "Limits", "what the forge caps, with default and bounds; change one"],
    ["teams", "Crew teams", "each team's charter, dial and members"],
    ["invites", "Invite links", "make a single-use link, see which are open, revoke one"],
    ["subscriptions", "Crew subscriptions", "each account's budget and rest; wake one, set its budget, add or remove one"],
    ["cloud", "Cloud accounts", "provider tokens, what they are used for, today's calls"],
    ["domains", "Failure domains", "failure domains and their last drill"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["owner", "Owner's needs", "what needs the owner, snapshots, failure domains"],
    ["forges", "Forges you sent", "each forge sent, claimed or not, and its apps"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("a site-admin agent is offered the roster without the person-only entries", () => {
  expect(roster({ ...admin, kind: "agent" })).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["profile", "Open a profile", "username or org"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["ssh-keys", "SSH keys", "list, add and remove the keys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["sentinel", "Sentinel", "the forge's open faults"],
    ["resilience", "Resilience", "where snapshots go and the mirror; each protection green, red or untested"],
    ["origin-apps", "Origin apps", "your OAuth apps for connecting origins; a adds, d removes"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["releases", "Releases", "the live release and the kept ones"],
    ["keeper", "Release keeper", "what holds the next cut, and each release it cut with its probes"],
    ["stalled", "Stalled steps", "pulls whose check is red or was never asked for; enter re-runs"],
    ["file-holds", "Held files", "hold new work on a file, release it, or list the holds"],
    ["secrets", "Secrets", "sealed secrets by name; set or remove one"],
    ["crew-scorecard", "Crew scorecard", "agent runs per model and per prompt version"],
    ["crew-handover", "Crew hand-overs", "issues parked twice, and the last restore drill"],
    ["scorecard", "Crew scorecard per agent", "each agent's pulls landed, review rounds, red checks, reverts, time to land"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["can", "What I can do", "your role and what it allows here"],
    ["cloud", "Cloud accounts", "provider tokens, what they are used for, today's calls"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["forges", "Forges you sent", "each forge sent, claimed or not, and its apps"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("a member person is offered the signed-in roster without the admin entries", () => {
  expect(roster(member)).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["profile", "Open a profile", "username or org"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["new-org", "New organization", "an organization you own, for a client's apps"],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["notify", "Phone notifications", "where the crew reaches your phone; s sets, x turns off"],
    ["ssh-keys", "SSH keys", "list, add and remove the keys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["origin-apps", "Origin apps", "your OAuth apps for connecting origins; a adds, d removes"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["stalled", "Stalled steps", "pulls whose check is red or was never asked for; enter re-runs"],
    ["file-holds", "Held files", "hold new work on a file, release it, or list the holds"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["model", "Model budget", "what your crew may spend, and add your own subscription"],
    ["can", "What I can do", "your role and what it allows here"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("signed out, the palette offers sign-in and the public entries", () => {
  expect(roster()).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["profile", "Open a profile", "username or org"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["signin", "Sign in", undefined],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});
