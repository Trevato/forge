import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    ["explore-feed", "Explore feed", "Atom address"],
    ["packs", "Forge packs", "premade forges to deploy, and how to help build their apps"],
    ["mirror-packs", "Mirror the packs' upstreams", "bring each pack's upstream projects in as read-only repositories"],
    ["pack-repos", "Pack repositories", "which repositories /packs lists"],
    ["send-change", "Send a change", "fork, patch, pull: no forge of your own"],
    ["interrupted-out", "Stopped runs", "runs the host stopped five times, with Try again"],
    ["get-a-forge", "Get your own forge", "the plans, where to get a hosted forge, how to run one yourself"],
    ["pricing", "Get a forge (plans)", "pick a plan, name it, pay at the checkout address"],
    ["data", "Data", "the SQLite files you may read as a tree; / filters, : asks in SQL, y yanks a row"],
    ["fleet", "Fleet rows", "the rows a fleet query line selects"],
    ["profile", "Open a profile", "username or org"],
    ["repos", "Repositories", "the repositories you may write"],
    ["displays", "Displays", "the displays you may read"],
    ["new-issue-anywhere", "New issue", "pick a repository"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["held", "Held by the Later gate", "owner/name"],
    ["fork-tree", "Fork tree of a repository", "owner/name"],
    ["roadmap", "Roadmap of a repository", "owner/name"],
    ["space", "Space of a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["week", "The week in a repository", "owner/name"],
    ["flows", "Flows of a repository", "owner/name"],
    ["findings", "Findings in a repository", "owner/name"],
    ["machines", "Machines of a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["work", "work (read-only)", "repositories mirrored from read-only origins, last fetch and why one failed"],
    ["new-app", "New app", "say what it does in a sentence; the crew starts on it"],
    ["new-app-template", "New app from a template", "copy a repository you can read, as the starting files"],
    ["bring-app", "Bring an app", "paste a link from another forge; it runs here"],
    ["new-org", "New organization", "an organization you own, for a client's apps"],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["thought-notes", "Notes", "write an idea and watch it become shipped work"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["shells", "Your shells", "the machine shells you hold, live then ended"],
    ["notify", "Phone notifications", "where the crew reaches your phone; s sets, x turns off"],
    ["confirms", "Confirms", "what the forge's agent asked to do; y does it once"],
    ["trusted", "Trusted sources", "who folds in without review; a trusts, x removes, s stops all, v reverts"],
    ["conversations", "Conversations", "your talks with the forge's agent; n starts one, r renames, x archives"],
    ["build-app", "Build an app", "say what to build; versions, diff, restore and publish. n starts one"],
    ["ssh-keys", "Computer keys", "list, add and remove the keys that sign in as you"],
    ["passkeys", "Passkeys", "the passkeys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["sentinel", "Sentinel", "the forge's open faults"],
    ["boards", "Boards", "the forge's boards and their panels"],
    ["drift", "Drifting pulls", "open pulls far behind main, and the one action that brings each up to date"],
    ["ask-data", "Data explorer", "start from a question about the forge's data"],
    ["bugs", "Bugs", "open bugs and the bug clock"],
    ["home-pins", "Pinned panels", "the panels pinned to home: reorder and unpin"],
    ["now", "Now", "what check, review, land and live count, with the rows"],
    ["front-milestones", "Milestones", "the biggest open milestones: how far, what landed this week"],
    ["forge-view", "Forge view", "the forge's counts, and Foundry when it is installed"],
    ["captain", "Captain", "what Talk remembers, and the check-ins it posts for you"],
    ["origin-apps", "Connection apps", "your OAuth apps for connecting accounts; a adds, d removes"],
    ["system-memory", "System memory", "RSS beside the JS heap, hourly for 24 h"],
    ["flow", "Flow", "the pipeline's bottleneck and throughput"],
    ["system", "System", "the machine now: CPU, memory, disks, processes"],
    ["pulls-to-land", "Pulls to land", "approved pulls, stale crew pulls, unproposed work"],
    ["valves", "Valves", "the week's budget as a valve per repository; turn one and the crew obeys"],
    ["refused-asks", "Refused first asks", "the last 20 first asks turned away"],
    ["disks", "Disks", "machines' disk readings: 30-day write rate and projected rated-TBW date"],
    ["telemetry", "Telemetry", "which agents may read flow and system; enter flips the grant"],
    ["stalls", "Main-thread stalls", "the last hour's stall ms by route"],
    ["footing", "What the forge stands on", "each piece on another machine, in the order it would break the forge"],
    ["offsite", "Off-site backup", "where the sealed lane writes, when it last succeeded, and the last restore drill"],
    ["capacity", "Capacity", "concurrency and guards, live; e changes a settable one"],
    ["resilience", "Resilience", "where snapshots go and the mirror; each protection green, red or untested"],
    ["maintenance", "Maintenance", "prepare the forge for a power-off, check the drain, or end maintenance"],
    ["maintenance-runs", "Maintenance duty runs", "what each duty found, did and probed"],
    ["maintenance-duties", "Pause or resume a maintenance duty", "switch a duty off, or on again after it paused itself"],
    ["maintenance-budgets", "Set a maintenance duty's budget", "runs per day and dollars per day a duty may use"],
    ["crawlers", "Crawlers", "their share of answering time, and who was refused"],
    ["scrapes", "Scrapes", "what was read by repository, and groups in a running capture"],
    ["traffic", "Traffic", "who is using the forge's answering time, and the top readers"],
    ["returning-visitors", "Who comes back", "new and returning visitors, and the setting that keeps them"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["docs", "Docs", "the forge's documentation; Enter reads one"],
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
    ["knobs", "Knobs", "speed, weekly budget, polish, autonomy, feedback first"],
    ["crew-handover", "Crew hand-overs", "issues parked twice, and the last restore drill"],
    ["scorecard", "Crew scorecard per agent", "each agent's pulls landed, review rounds, red checks, reverts, time to land"],
    ["crew-week", "Crew this week", "each agent's pulls merged, returned and spend over 7 days"],
    ["forge-spend", "Forge spend", "today and the last 24 hours, headroom per subscription"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["model", "Model budget", "what your crew may spend, and add your own subscription"],
    ["model-grant", "Model grant", "give an account dollars a month, or take it back"],
    ["model-ceiling", "Model ceiling", "set an account's dollars a day and a run"],
    ["can", "What I can do", "your role and what it allows here"],
    ["people", "People", "who is a guest, a member or an admin; promote or demote"],
    ["account-access", "Account access", "search people, reset access, end sessions"],
    ["quotas", "Account quotas", "what one account may own, and who changed it"],
    ["limits", "Limits", "what the forge caps, with default and bounds; change one"],
    ["plans", "Plans", "free, small, medium and large: size, price, crew credit, forges; change one"],
    ["economics", "Economics", "the profit slider's position, the margin, the owned-node label and the prices; change one"],
    ["flows-all", "Flows across the forge", "every repository's flow lines, by kind and stale"],
    ["teams", "Crew teams", "each team's charter, dial and members"],
    ["billing-links", "Buy links", "where each hosted plan is paid for, shown on the home page"],
    ["plan-row", "Plan", "this forge's plan, and where its owner manages billing"],
    ["agents", "Crew agents", "each agent's model, budget and brief"],
    ["invites", "Invite links", "make a single-use link, see which are open, revoke one"],
    ["claim-start", "Take an agent's work", "claim the repositories an agent started, from its one-time link"],
    ["requests", "Waiting", "strangers who asked for an account: allow or decline"],
    ["bulk", "Bulk actions", "your last bulk actions; u undoes one inside its day"],
    ["subscriptions", "Crew subscriptions", "each account's budget and rest; wake one, set its budget, add or remove one"],
    ["crewkey", "Crew key", "what the crew runs on; add your own model key"],
    ["money", "Money", "this month's cost, revenue and gap, and the last 30 days"],
    ["app-templates", "App templates", "the repositories New app offers; mark or unmark one"],
    ["devices", "Devices", "LAN printers: model, state, supplies; declare or remove one"],
    ["edge-only-accounts", "Edge-only accounts", "who would be locked out if the platform edge sign-in went off"],
    ["way-back-links", "Way-back links", "a link that signs in an account the edge made, once the edge is gone"],
    ["traffic-sources", "Traffic sources", "where people come from and where they go, for the forge"],
    ["from-visit-to-paid", "From visit to paid", "the last 7 days: home visits, plans seen, plan clicks, forges made, paid"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["security-controls", "Security controls", "each safeguard, and when it was last tested"],
    ["billing", "Billing", "each forge's plan, and grant one by hand"],
    ["lapsed", "Lapsed forges", "forges asleep until paid, when their data goes, pay again"],
    ["codes", "Gift codes", "make a code that gives a plan for free, and revoke one"],
    ["archived", "Archived repositories", "put away, not gone: open one or restore it"],
    ["cloud", "Cloud accounts", "provider tokens, what they are used for, today's calls"],
    ["pinned", "Pinned forges", "deploy, update and roll back a forge on your cloud"],
    ["bets", "Bets", "back, stop and finish a repository\'s bets"],
    ["origins", "Connected accounts", "the hosts your mirrors come from"],
    ["domains", "Failure domains", "failure domains and their last drill"],
    ["feed", "Feed", "what happened, ranked; r replies on a post about an issue or pull, l likes, h who liked"],
    ["feature-review", "Menu entries to review", "absorbed apps whose declared name or page changed: accept them"],
    ["feature-feed", "Feature feeds", "the feed items about an absorbed app, as Settings › Features shows them"],
    ["features", "Features", "apps that declare a feature: absorb one, change its settings"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["owner", "Owner's needs", "what needs the owner, snapshots, failure domains"],
    ["forges", "Forges you sent", "each forge sent, claimed or not, and its apps"],
    ["forge-ready", "Does a forge answer?", "ask whether a forge you sent answers yet"],
    ["lend-credit", "Lend a child credit", "set the dollars a forge you sent may spend on this one's model credential"],
    ["origin-ahead", "New commits upstream", "mirrors whose origin has moved on: take them"],
    ["profile", "Your profile", "display name and email"],
    ["dotfiles", "Your dotfiles", "the repository every shell you open copies from"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("a site-admin agent is offered the roster without the person-only entries", () => {
  expect(roster({ ...admin, kind: "agent" })).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["explore-feed", "Explore feed", "Atom address"],
    ["packs", "Forge packs", "premade forges to deploy, and how to help build their apps"],
    ["send-change", "Send a change", "fork, patch, pull: no forge of your own"],
    ["interrupted-out", "Stopped runs", "runs the host stopped five times, with Try again"],
    ["get-a-forge", "Get your own forge", "the plans, where to get a hosted forge, how to run one yourself"],
    ["pricing", "Get a forge (plans)", "pick a plan, name it, pay at the checkout address"],
    ["data", "Data", "the SQLite files you may read as a tree; / filters, : asks in SQL, y yanks a row"],
    ["fleet", "Fleet rows", "the rows a fleet query line selects"],
    ["profile", "Open a profile", "username or org"],
    ["repos", "Repositories", "the repositories you may write"],
    ["displays", "Displays", "the displays you may read"],
    ["new-issue-anywhere", "New issue", "pick a repository"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["held", "Held by the Later gate", "owner/name"],
    ["fork-tree", "Fork tree of a repository", "owner/name"],
    ["roadmap", "Roadmap of a repository", "owner/name"],
    ["space", "Space of a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["week", "The week in a repository", "owner/name"],
    ["flows", "Flows of a repository", "owner/name"],
    ["findings", "Findings in a repository", "owner/name"],
    ["machines", "Machines of a repository", "owner/name"],
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
    ["ssh-keys", "Computer keys", "list, add and remove the keys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["sentinel", "Sentinel", "the forge's open faults"],
    ["resilience", "Resilience", "where snapshots go and the mirror; each protection green, red or untested"],
    ["origin-apps", "Connection apps", "your OAuth apps for connecting accounts; a adds, d removes"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["docs", "Docs", "the forge's documentation; Enter reads one"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["releases", "Releases", "the live release and the kept ones"],
    ["keeper", "Release keeper", "what holds the next cut, and each release it cut with its probes"],
    ["stalled", "Stalled steps", "pulls whose check is red or was never asked for; enter re-runs"],
    ["file-holds", "Held files", "hold new work on a file, release it, or list the holds"],
    ["secrets", "Secrets", "sealed secrets by name; set or remove one"],
    ["usage", "Usage", "the forge's spend and headroom; an admin also sees every route"],
    ["crew-scorecard", "Crew scorecard", "agent runs per model and per prompt version"],
    ["knobs", "Knobs", "speed, weekly budget, polish, autonomy, feedback first"],
    ["crew-handover", "Crew hand-overs", "issues parked twice, and the last restore drill"],
    ["scorecard", "Crew scorecard per agent", "each agent's pulls landed, review rounds, red checks, reverts, time to land"],
    ["crew-week", "Crew this week", "each agent's pulls merged, returned and spend over 7 days"],
    ["forge-spend", "Forge spend", "today and the last 24 hours, headroom per subscription"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["can", "What I can do", "your role and what it allows here"],
    ["bugs", "Bugs", "open bugs and the bug clock"],
    ["maintenance-runs", "Maintenance duty runs", "what each duty found, did and probed"],
    ["traffic-sources", "Traffic sources", "where people come from and where they go, for the forge"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["archived", "Archived repositories", "put away, not gone: open one or restore it"],
    ["plan-row", "Plan", "this forge's plan, and where its owner manages billing"],
    ["cloud", "Cloud accounts", "provider tokens, what they are used for, today's calls"],
    ["pinned", "Pinned forges", "deploy, update and roll back a forge on your cloud"],
    ["feed", "Feed", "what happened, ranked; r replies on a post about an issue or pull, l likes, h who liked"],
    ["feature-feed", "Feature feeds", "the feed items about an absorbed app, as Settings › Features shows them"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["forges", "Forges you sent", "each forge sent, claimed or not, and its apps"],
    ["forge-ready", "Does a forge answer?", "ask whether a forge you sent answers yet"],
    ["lend-credit", "Lend a child credit", "set the dollars a forge you sent may spend on this one's model credential"],
    ["origin-ahead", "New commits upstream", "mirrors whose origin has moved on: take them"],
    ["front-milestones", "Milestones", "the biggest open milestones: how far, what landed this week"],
    ["forge-view", "Forge view", "the forge's counts, and Foundry when it is installed"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("no agent is offered Connected accounts", () => {
  expect(roster({ ...admin, kind: "agent" }).map(([id]) => id)).not.toContain("origins");
});

test("a member person is offered the signed-in roster without the admin entries", () => {
  expect(roster(member)).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["explore-feed", "Explore feed", "Atom address"],
    ["packs", "Forge packs", "premade forges to deploy, and how to help build their apps"],
    ["send-change", "Send a change", "fork, patch, pull: no forge of your own"],
    ["interrupted-out", "Stopped runs", "runs the host stopped five times, with Try again"],
    ["get-a-forge", "Get your own forge", "the plans, where to get a hosted forge, how to run one yourself"],
    ["pricing", "Get a forge (plans)", "pick a plan, name it, pay at the checkout address"],
    ["fleet", "Fleet rows", "the rows a fleet query line selects"],
    ["profile", "Open a profile", "username or org"],
    ["repos", "Repositories", "the repositories you may write"],
    ["displays", "Displays", "the displays you may read"],
    ["new-issue-anywhere", "New issue", "pick a repository"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["held", "Held by the Later gate", "owner/name"],
    ["fork-tree", "Fork tree of a repository", "owner/name"],
    ["roadmap", "Roadmap of a repository", "owner/name"],
    ["space", "Space of a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["week", "The week in a repository", "owner/name"],
    ["flows", "Flows of a repository", "owner/name"],
    ["findings", "Findings in a repository", "owner/name"],
    ["machines", "Machines of a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["new-repo", "New repository", undefined],
    ["work", "work (read-only)", "repositories mirrored from read-only origins, last fetch and why one failed"],
    ["new-app", "New app", "say what it does in a sentence; the crew starts on it"],
    ["new-app-template", "New app from a template", "copy a repository you can read, as the starting files"],
    ["bring-app", "Bring an app", "paste a link from another forge; it runs here"],
    ["new-org", "New organization", "an organization you own, for a client's apps"],
    ["migrate", "Migrate a repository", "bring one in from an origin or a URL, pick its branch, put a crew on it"],
    ["new-forge", "New forge", "spawn a client's forge and get its claim link"],
    ["asked", "Asked", "your thoughts and what became of them"],
    ["thought-notes", "Notes", "write an idea and watch it become shipped work"],
    ["decider", "Decider", "what it closed, deferred and asked you about today"],
    ["shells", "Your shells", "the machine shells you hold, live then ended"],
    ["notify", "Phone notifications", "where the crew reaches your phone; s sets, x turns off"],
    ["confirms", "Confirms", "what the forge's agent asked to do; y does it once"],
    ["conversations", "Conversations", "your talks with the forge's agent; n starts one, r renames, x archives"],
    ["build-app", "Build an app", "say what to build; versions, diff, restore and publish. n starts one"],
    ["ssh-keys", "Computer keys", "list, add and remove the keys that sign in as you"],
    ["passkeys", "Passkeys", "the passkeys that sign in as you"],
    ["account", "Account settings", undefined],
    ["signins", "Signed in", "your browsers and tokens; d signs a browser out"],
    ["origin-apps", "Connection apps", "your OAuth apps for connecting accounts; a adds, d removes"],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["docs", "Docs", "the forge's documentation; Enter reads one"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["stalled", "Stalled steps", "pulls whose check is red or was never asked for; enter re-runs"],
    ["file-holds", "Held files", "hold new work on a file, release it, or list the holds"],
    ["usage", "Usage", "the forge's spend and headroom; an admin also sees every route"],
    ["forge-spend", "Forge spend", "today and the last 24 hours, headroom per subscription"],
    ["proposal-tokens", "Proposal tokens", "mint, list and revoke what a child proposes with"],
    ["model", "Model budget", "what your crew may spend, and add your own subscription"],
    ["can", "What I can do", "your role and what it allows here"],
    ["bugs", "Bugs", "open bugs and the bug clock"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["archived", "Archived repositories", "put away, not gone: open one or restore it"],
    ["claim-start", "Take an agent's work", "claim the repositories an agent started, from its one-time link"],
    ["bulk", "Bulk actions", "your last bulk actions; u undoes one inside its day"],
    ["bets", "Bets", "back, stop and finish a repository\'s bets"],
    ["origins", "Connected accounts", "the hosts your mirrors come from"],
    ["feed", "Feed", "what happened, ranked; r replies on a post about an issue or pull, l likes, h who liked"],
    ["feature-feed", "Feature feeds", "the feed items about an absorbed app, as Settings › Features shows them"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["origin-ahead", "New commits upstream", "mirrors whose origin has moved on: take them"],
    ["profile", "Your profile", "display name and email"],
    ["dotfiles", "Your dotfiles", "the repository every shell you open copies from"],
    ["front-milestones", "Milestones", "the biggest open milestones: how far, what landed this week"],
    ["forge-view", "Forge view", "the forge's counts, and Foundry when it is installed"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

test("signed out, the palette offers sign-in and the public entries", () => {
  expect(roster()).toEqual([
    ["home", "Home", "your repositories"],
    ["explore", "Explore", "on the web"],
    ["explore-feed", "Explore feed", "Atom address"],
    ["packs", "Forge packs", "premade forges to deploy, and how to help build their apps"],
    ["send-change", "Send a change", "fork, patch, pull: no forge of your own"],
    ["interrupted-out", "Stopped runs", "runs the host stopped five times, with Try again"],
    ["get-a-forge", "Get your own forge", "the plans, where to get a hosted forge, how to run one yourself"],
    ["start-forge", "Start my forge", "a free forge of your own; you choose a username and password next"],
    ["pricing", "Get a forge (plans)", "pick a plan, name it, pay at the checkout address"],
    ["forge-name", "Is a forge name free?", "ask whether Start my forge would take a name"],
    ["fleet", "Fleet rows", "the rows a fleet query line selects"],
    ["profile", "Open a profile", "username or org"],
    ["repo", "Open a repository", "owner/name"],
    ["issues", "Issues in a repository", "owner/name"],
    ["held", "Held by the Later gate", "owner/name"],
    ["fork-tree", "Fork tree of a repository", "owner/name"],
    ["roadmap", "Roadmap of a repository", "owner/name"],
    ["space", "Space of a repository", "owner/name"],
    ["pulls", "Pull requests in a repository", "owner/name"],
    ["milestones", "Milestones in a repository", "owner/name"],
    ["next-up", "Next up in a repository", "owner/name"],
    ["week", "The week in a repository", "owner/name"],
    ["flows", "Flows of a repository", "owner/name"],
    ["findings", "Findings in a repository", "owner/name"],
    ["machines", "Machines of a repository", "owner/name"],
    ["repo-usage", "Usage of a repository", "owner/name"],
    ["new-issue", "New issue", "owner/name"],
    ["new-pull", "New pull request", "owner/name"],
    ["settings", "Repository settings", "owner/name"],
    ["signin", "Sign in", undefined],
    ["api", "API", "the forge's endpoints; run a GET"],
    ["docs", "Docs", "the forge's documentation; Enter reads one"],
    ["changelog", "Changelog", "the last 30 releases and their pulls"],
    ["bugs", "Bugs", "open bugs and the bug clock"],
    ["audit", "Who can do what", "each app's doors from its contract.json: yes, own or no"],
    ["front", "Front page", "the apps a first visitor sees, ranked; an admin pins or hides"],
    ["origin-ahead", "New commits upstream", "mirrors whose origin has moved on: take them"],
    ["front-milestones", "Milestones", "the biggest open milestones: how far, what landed this week"],
    ["family", "Family", "the forge that sent this one, and the forges it sent"],
    ["chain", "Chain", "the forges this forge's code descends from, root first"],
    ["quit", "Quit", "disconnect"],
  ]);
});

// ---- the pull page's palette: the page's actions and the palette's rows are one set ----

import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pullRoster, type PullRosterInput } from "../src/web/studio/pull_roster.ts";

describe("on a pull's Files step the palette lists what the page offers this reader", () => {
  let pdir: string;
  let papp: App;
  let servers: Servers;
  let writerCookie = "";
  let readerCookie = "";
  const thread = "/wendy/lib/pulls/1";

  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    pdir = await mkdtemp(join(tmpdir(), "forge-palette-pull-"));
    papp = createApp({ dataDir: pdir, port: 0, host: "forge.test" });
    servers = await serve(papp);
    const mk = async (username: string, adminIfFirst: boolean) => {
      const r = await createUser(papp.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", adminIfFirst,
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const wendy = await mk("wendy", true);
    await mk("rhea", false);
    const r = await createRepo(papp, wendy, { name: "lib", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    for (const [branch, content] of [["main", "a\n"], ["feat", "a\nb\n"]] as const) {
      const done = await commitToBranch(papp, wendy, r.value, {
        branch, message: branch, files: [{ path: "f.txt", content }],
      });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
    const opened = await openPull(papp, wendy, r.value, { title: "Feat", baseBranch: "main", headBranch: "feat" });
    if (!opened.ok) throw new Error(String(opened.error));
    // A second pull, closed without merging: its page offers Reopen.
    const second = await openPull(papp, wendy, r.value, { title: "Gone", baseBranch: "main", headBranch: "feat" });
    if (!second.ok) throw new Error(String(second.error));
    writerCookie = await signIn("wendy");
    readerCookie = await signIn("rhea");
  }, 120_000);

  afterAll(async () => {
    await servers.stop();
    papp.close();
    await rm(pdir, { recursive: true, force: true });
  });

  // The page's form actions, by the palette row that stands for each.
  const STANDS_FOR: Record<string, string> = {
    checks: "Check again", merge: "Merge pull request", "review-state": "Review", assignee: "Assign",
    labels: "Labels", ship: "Ship", hold: "Hold", state: "Close pull request", edit: "Edit", comments: "Comment",
  };
  const READING = ["Conversation", "Files", "Branch", "Commits"];

  const read = async (path: string, cookie: string, at = thread) => {
    const html = await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
    const index = JSON.parse(/id="palette-index">([^<]*)</.exec(html)![1]!) as {
      items: { t: string; h: string; c?: string; p?: Record<string, string> }[];
    };
    const forms = [...html.matchAll(/<form\s[^>]*action="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((a) => a.startsWith(`${at}/`))
      .map((a) => {
        const verb = STANDS_FOR[a.slice(at.length + 1)];
        if (verb === undefined) throw new Error(`the page has a form the palette does not know: ${a}`);
        return verb;
      });
    return { rows: index.items.filter((i) => i.c === "This pull"), forms };
  };

  for (const [who, kind] of [["writer", () => writerCookie], ["reader", () => readerCookie]] as const) {
    for (const [tab, path] of [["Conversation", thread], ["Files", `${thread}/files`]] as const) {
      test(`on the ${tab} tab a ${who}'s action rows are exactly the page's forms`, async () => {
        const { rows, forms } = await read(path, kind());
        // The Files tab has no comment form of its own: its Comment row links to the Conversation's.
        const acts = rows.map((r) => r.t).filter((t) => !READING.includes(t) && !(tab === "Files" && t === "Comment"));
        const same = (t: string) => (t === "Bring up to date" ? "Ship" : t);
        expect(acts.map(same).sort()).toEqual([...new Set(forms)].sort());
        // A row that posts goes to a form action the page has, with a path of its own.
        for (const r of rows.filter((x) => x.p)) expect(r.h.startsWith(`${thread}/`)).toBe(true);
        // No title twice.
        expect(new Set(rows.map((r) => r.t)).size).toBe(rows.length);
      });
    }
  }

  test("on a closed pull, Reopen is on the page and in the palette for its author or a writer alone", async () => {
    const at = "/wendy/lib/pulls/2";
    const shut = await fetch(`${servers.url}${at}/state`, {
      method: "POST",
      headers: { cookie: writerCookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: "state=closed",
      redirect: "manual",
    });
    expect(shut.status).toBeLessThan(400);
    const same = (t: string) => (t === "Close pull request" ? "Reopen pull request" : t);
    for (const [cookie, may] of [[writerCookie, true], [readerCookie, false]] as const) {
      for (const path of [at, `${at}/files`]) {
        const { rows, forms } = await read(path, cookie, at);
        const acts = rows
          .map((r) => r.t)
          .filter((t) => !READING.includes(t) && !(path.endsWith("/files") && t === "Comment"));
        expect(acts.sort()).toEqual([...new Set(forms.map(same))].sort());
        const reopen = rows.find((r) => r.t === "Reopen pull request");
        if (may) expect(reopen).toMatchObject({ h: `${at}/state`, p: { state: "open" } });
        else expect(reopen).toBeUndefined();
      }
    }
  });

  test("both tabs list the same reading rows, and no row points at the Files page twice", async () => {
    for (const path of [thread, `${thread}/files`]) {
      const { rows } = await read(path, writerCookie);
      expect(rows.filter((r) => READING.includes(r.t)).map((r) => r.t)).toEqual(READING);
      expect(rows.filter((r) => r.h === `${thread}/files`).length).toBe(1);
    }
  });

  test("a reader may review and comment on the Files tab, but not assign, check or merge", async () => {
    const titles = (await read(`${thread}/files`, readerCookie)).rows.map((r) => r.t);
    expect(titles).toEqual(expect.arrayContaining(["Conversation", "Files", "Branch", "Comment", "Review"]));
    for (const t of ["Assign", "Labels", "Check again", "Merge pull request"]) expect(titles).not.toContain(t);
  });

  test("a writer is offered every action the page has", async () => {
    const titles = (await read(`${thread}/files`, writerCookie)).rows.map((r) => r.t);
    expect(titles).toEqual(
      expect.arrayContaining(["Conversation", "Files", "Branch", "Commits", "Comment", "Review", "Assign", "Check again", "Merge pull request"]),
    );
  });

  test("a signed-out visitor is offered only the reading rows", async () => {
    const titles = (await read(`${thread}/files`, "")).rows.map((r) => r.t);
    expect(titles).toEqual(["Conversation", "Files", "Branch", "Commits"]);
  });

  test("the rules, one by one", () => {
    const base: PullRosterInput = {
      base: "/o/r", number: 3, headBranch: "a b", crossRepo: false, signedIn: true, writer: true,
      state: "open", merged: false, mergeReady: true, labels: true, mayState: true,
    };
    const titles = (o: Partial<PullRosterInput>) => pullRoster({ ...base, ...o }).map((r) => r.t);
    expect(pullRoster(base).find((r) => r.t === "Merge pull request")).toMatchObject({ h: "/o/r/pulls/3/merge", p: { strategy: "merge" } });
    expect(titles({ mergeReady: false })).not.toContain("Merge pull request");
    expect(pullRoster(base).find((r) => r.t === "Branch")!.h).toBe("/o/r/tree/a%20b");
    expect(titles({ crossRepo: true })).not.toContain("Branch");
    expect(titles({ merged: true })).not.toContain("Comment");
    expect(titles({ state: "closed" })).not.toContain("Check again");
    expect(titles({ labels: false })).not.toContain("Labels");
    expect(titles({ labels: true })).toContain("Labels");
    expect(titles({})).not.toContain("Diff");
    expect(titles({})).not.toContain("Reopen pull request");
    expect(titles({ state: "closed" })).toContain("Reopen pull request");
    expect(titles({ state: "closed", mayState: false })).not.toContain("Reopen pull request");
    expect(titles({ state: "closed", merged: true })).not.toContain("Reopen pull request");
    expect(pullRoster(base).filter((r) => r.p).every((r) => r.h.startsWith("/o/r/pulls/3/"))).toBe(true);
  });
});
