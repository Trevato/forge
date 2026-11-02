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
    ["held", "Held by the Later gate", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["new-app", "New app", "say what it does in a sentence; the crew starts on it"],
    ["new-org", "New organization", "an organization you own, for a client's apps"],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["thought-notes", "Notes", "write an idea and watch it become shipped work"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["notify", "Phone notifications", "where the crew reaches your phone; s sets, x turns off"],
    ["confirms", "Confirms", "what the forge's agent asked to do; y does it once"],
    ["ssh-keys", "SSH keys", "list, add and remove the keys that sign in as you"],
    ["passkeys", "Passkeys", "the passkeys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["sentinel", "Sentinel", "the forge's open faults"],
    ["boards", "Boards", "the forge's boards and their panels"],
    ["origin-apps", "Origin apps", "your OAuth apps for connecting origins; a adds, d removes"],
    ["system-memory", "System memory", "RSS beside the JS heap, hourly for 24 h"],
    ["flow", "Flow", "the pipeline's bottleneck and throughput"],
    ["system", "System", "the machine now: CPU, memory, disks, processes"],
    ["valves", "Valves", "the week's budget as a valve per repository; turn one and the crew obeys"],
    ["telemetry", "Telemetry", "which agents may read flow and system; enter flips the grant"],
    ["capacity", "Capacity", "concurrency and guards, live; e changes a settable one"],
    ["resilience", "Resilience", "where snapshots go and the mirror; each protection green, red or untested"],
    ["crawlers", "Crawlers", "their share of answering time, and who was refused"],
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
    ["usage", "Usage", "the forge's spend and headroom; an admin also sees every route"],
    ["crew-scorecard", "Crew scorecard", "agent runs per model and per prompt version"],
    ["crew-handover", "Crew hand-overs", "issues parked twice, and the last restore drill"],
    ["scorecard", "Crew scorecard per agent", "each agent's pulls landed, review rounds, red checks, reverts, time to land"],
    ["forge-spend", "Forge spend", "today and the last 24 hours, headroom per subscription"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["model", "Model budget", "what your crew may spend, and add your own subscription"],
    ["model-grant", "Model grant", "give an account dollars a month, or take it back"],
    ["model-ceiling", "Model ceiling", "set an account's dollars a day and a run"],
    ["can", "What I can do", "your role and what it allows here"],
    ["people", "People", "who is a guest, a member or an admin; promote or demote"],
    ["quotas", "Account quotas", "what one account may own, and who changed it"],
    ["limits", "Limits", "what the forge caps, with default and bounds; change one"],
    ["teams", "Crew teams", "each team's charter, dial and members"],
    ["agents", "Crew agents", "each agent's model, budget and brief"],
    ["invites", "Invite links", "make a single-use link, see which are open, revoke one"],
    ["bulk", "Bulk actions", "your last bulk actions; u undoes one inside its day"],
    ["subscriptions", "Crew subscriptions", "each account's budget and rest; wake one, set its budget, add or remove one"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["archived", "Archived repositories", "put away, not gone: open one or wake it"],
    ["cloud", "Cloud accounts", "provider tokens, what they are used for, today's calls"],
    ["pinned", "Pinned forges", "deploy, update and roll back a forge on your cloud"],
    ["origins", "Connected origins", "the hosts your mirrors come from"],
    ["domains", "Failure domains", "failure domains and their last drill"],
    ["feed", "Feed", "what happened, ranked; r replies on a post about an issue or pull, l likes"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["owner", "Owner's needs", "what needs the owner, snapshots, failure domains"],
    ["forges", "Forges you sent", "each forge sent, claimed or not, and its apps"],
    ["profile", "Your profile", "display name and email"],
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
    ["held", "Held by the Later gate", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["thought-notes", "Notes", "write an idea and watch it become shipped work"],
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
    ["usage", "Usage", "the forge's spend and headroom; an admin also sees every route"],
    ["crew-scorecard", "Crew scorecard", "agent runs per model and per prompt version"],
    ["crew-handover", "Crew hand-overs", "issues parked twice, and the last restore drill"],
    ["scorecard", "Crew scorecard per agent", "each agent's pulls landed, review rounds, red checks, reverts, time to land"],
    ["forge-spend", "Forge spend", "today and the last 24 hours, headroom per subscription"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["can", "What I can do", "your role and what it allows here"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["archived", "Archived repositories", "put away, not gone: open one or wake it"],
    ["cloud", "Cloud accounts", "provider tokens, what they are used for, today's calls"],
    ["pinned", "Pinned forges", "deploy, update and roll back a forge on your cloud"],
    ["feed", "Feed", "what happened, ranked; r replies on a post about an issue or pull, l likes"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["forges", "Forges you sent", "each forge sent, claimed or not, and its apps"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("no agent is offered Connected origins", () => {
  expect(roster({ ...admin, kind: "agent" }).map(([id]) => id)).not.toContain("origins");
});

test("a member person is offered the signed-in roster without the admin entries", () => {
  expect(roster(member)).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["profile", "Open a profile", "username or org"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["held", "Held by the Later gate", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["new-app", "New app", "say what it does in a sentence; the crew starts on it"],
    ["new-org", "New organization", "an organization you own, for a client's apps"],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["thought-notes", "Notes", "write an idea and watch it become shipped work"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["notify", "Phone notifications", "where the crew reaches your phone; s sets, x turns off"],
    ["confirms", "Confirms", "what the forge's agent asked to do; y does it once"],
    ["ssh-keys", "SSH keys", "list, add and remove the keys that sign in as you"],
    ["passkeys", "Passkeys", "the passkeys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["origin-apps", "Origin apps", "your OAuth apps for connecting origins; a adds, d removes"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["stalled", "Stalled steps", "pulls whose check is red or was never asked for; enter re-runs"],
    ["file-holds", "Held files", "hold new work on a file, release it, or list the holds"],
    ["usage", "Usage", "the forge's spend and headroom; an admin also sees every route"],
    ["forge-spend", "Forge spend", "today and the last 24 hours, headroom per subscription"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["model", "Model budget", "what your crew may spend, and add your own subscription"],
    ["can", "What I can do", "your role and what it allows here"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["archived", "Archived repositories", "put away, not gone: open one or wake it"],
    ["bulk", "Bulk actions", "your last bulk actions; u undoes one inside its day"],
    ["origins", "Connected origins", "the hosts your mirrors come from"],
    ["feed", "Feed", "what happened, ranked; r replies on a post about an issue or pull, l likes"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["profile", "Your profile", "display name and email"],
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
    ["held", "Held by the Later gate", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["signin", "Sign in", undefined],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});
