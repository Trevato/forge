/**
 * The tag of an OpenAPI operation: the resource its path acts on. Plain
 * data in, plain data out; `openapi.ts` stamps it on every operation and
 * `served.ts` slices the document by it (`?tag=pulls`, #11091).
 */

/** A path segment that names a resource under another tag. */
const ALIAS: Readonly<Record<string, string>> = {
  app: "apps",
  timers: "apps",
  schedules: "apps",
  jobs: "apps",
  "app-templates": "apps",
  display: "builds",
  following: "forks",
  upstream: "forks",
  "make-it-yours": "forks",
  contribute: "forks",
  queue: "gates",
  growth: "issues",
  chapters: "issues",
  checks: "pulls",
  conversation: "conversations",
  "conversation-confirms": "conversations",
  "conversation-tokens": "conversations",
  origin: "repos",
  "origin-hook": "repos",
  sync: "repos",
  transfer: "repos",
  atlas: "repos",
  tags: "repos",
  branches: "repos",
  commits: "repos",
  contents: "repos",
  statement: "plan",
  vision: "plan",
  roadmap: "plan",
  iterations: "plan",
  edits: "plan",
  waves: "plan",
  users: "user",
  secrets: "tokens",
  sessions: "tokens",
  "first-admin": "admin",
  health: "meta",
  version: "meta",
  releases: "meta",
  release: "meta",
  changelog: "meta",
  flags: "meta",
  here: "meta",
  map: "meta",
  api: "meta",
  mcp: "meta",
  metrics: "meta",
  packs: "meta",
  keeper: "meta",
  heartbeat: "meta",
  telemetry: "meta",
  drills: "meta",
  maintenance: "meta",
  devices: "meta",
  thoughts: "feed",
  share: "feed",
  explore: "feed",
  front: "feed",
  search: "feed",
  family: "forges",
  plans: "forges",
  start: "forges",
  cloud: "forges",
  migrate: "forges",
  returns: "billing",
  credit: "billing",
  spend: "billing",
  codes: "billing",
  usage: "billing",
  forge: "forges",
  passport: "user",
  "proposal-tokens": "tokens",
  asked: "asks",
  decisions: "runs",
  events: "runs",
  flow: "runs",
  agents: "crew",
  fleet: "crew",
  features: "meta",
  orgs: "forges",
  boards: "forges",
  data: "apps",
  "data-import": "apps",
};

/** One line on each tag the document lists. */
export const TAG_WORDS: Readonly<Record<string, string>> = {
  admin: "Administration: accounts, settings, the forge's own state (admin role)",
  apps: "An app's deployment: environments, domains, env vars, members, notes, templates, its data files",
  asks: "Questions the crew asks a person, and their answers",
  billing: "Credit, spend, usage and returns",
  builds: "Builds of a pull or branch, their screenshots and cart",
  contract: "This description of the API",
  conversations: "Conversations with the crew and the tokens that confirm them",
  crew: "The agents of a repository, their fleet and their roster",
  "egress-grants": "Hosts an app may reach",
  feed: "The timeline, posts, shares, search and exploring",
  forges: "Forges, organizations and boards: creating and following them",
  forks: "Forks, upstream following, offers and make-it-yours",
  gates: "The gate queue and the log of each gate",
  hooks: "Webhooks of a repository and their deliveries",
  issues: "Issues, their comments, dependencies, teams and plans",
  labels: "Labels on issues and pulls",
  meta: "The forge itself: health, version, manifest, flags, telemetry",
  milestones: "Milestones and watching them",
  plan: "A repository's vision, statement, roadmap, iterations and waves",
  prompts: "Saved prompts and running them",
  pulls: "Pull requests: reviews, threads, checks, looks, merging and holding",
  repos: "A repository: its record, branches, commits, contents, tags, origin and transfer",
  reports: "Reports filed on a repository and their triage",
  runs: "Runs of the crew: logs, steering, cancelling, decisions and events",
  tokens: "API tokens, sessions and secrets",
  user: "The signed-in person and people: profile, keys, settings, notifications",
};

/** The tag of the route at `path`. */
export function tagOf(path: string): string {
  const s = path.split("/").filter(Boolean);
  let raw: string;
  if (s[0] !== "api") raw = s[0] ?? "meta";
  else if (s[2] === "repos") raw = s[5] ?? "repos";
  else if (s[2] === "openapi.json") raw = "contract";
  else raw = s[2] ?? "api";
  return ALIAS[raw] ?? raw;
}

/** The tag list the document opens with, sorted. */
export const tagList = (tags: Iterable<string>): { name: string; description: string }[] =>
  [...new Set(tags)].sort().map((name) => ({ name, description: TAG_WORDS[name] ?? name }));
