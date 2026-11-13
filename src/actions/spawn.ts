/**
 * Spawn: make the child a plan describes. A new forge instance placed by the
 * placement seam, an org in it, the chosen apps as repositories with their
 * whole history, the crew's briefs, and one `parent.json` pointing back —
 * the upstream URL and nothing secret. Owner-only, same-origin, and the plan
 * is validated again here: the dry-run is a preview, never a permit.
 *
 * Everything the copy writes lives under the child's own data directory
 * (`<data>/children/<bodyId>`). The parent keeps one ledger line per child
 * (`<data>/spawn/<name>.json`) written before the first copy, so a retry
 * finds the half-made child and resumes it — every step below is
 * idempotent — and a finished one is answered, not made twice.
 */

import { nameShapeVerdict, nameVerdict, type NameVerdict } from "../spawn/name_verdict.ts";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createApp, type App } from "../app.ts";
import { tellPlan } from "../billing/notice.ts";
import {
  addCrew,
  BRIEF_MAX,
  createAgentRow,
  getAgentByName,
  listCrewRoles,
  setCrewRole,
  updateAgent,
} from "../core/agents.ts";
import { createOrg, getOrg } from "../core/orgs.ts";
import { setMember } from "../core/roles.ts";
import {
  canRead,
  createRepo,
  getRepo,
  updateRepoSettings,
  type Repo,
} from "../core/repos.ts";
import { createUser, getUserByName, type User } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { commitFiles } from "../git/write.ts";
import { adoptForgeCode, forkForgeCode } from "../spawn/forge_code.ts";
import { lendIncludedCredit } from "../spawn/included_credit.ts";
import { seedStarterCrew } from "../spawn/starter_crew.ts";
import { birthFromTemplate, type TemplateMark } from "../spawn/template_birth.ts";
import { sha256 } from "../kernel/hash.ts";
import { secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { crossOrigin } from "../http/context.ts";
import {
  addSubscription,
  getSubscriptionByName,
  lockBudget,
  normalizeToken,
  setGrants,
  subscriptionAad,
} from "../core/subscriptions.ts";
import { Database } from "bun:sqlite";
import { loadKey, open } from "../kernel/secret.ts";
import { loadOrCreateHostKey } from "../ssh/keys.ts";
import { claimLink, hasAdmin, mintClaim, PLACEHOLDER_FOUNDER, spawnedOrg } from "../spawn/claim.ts";
import { childPublicUrl, parentOrigin, type Placement, type PlacementKind } from "../spawn/placement.ts";
import { quotaRefusal } from "../spawn/quota.ts";
import { personRefusal, planRefusal } from "../spawn/sleep.ts";
import { FREE, getPlan, PAID_PLAN_ADMIN_ONLY } from "../settings/plans.ts";
import { setCap } from "../spawn/credit.ts";
import { fundingOf, keepFunding } from "../spawn/funding.ts";
import { planSpawn, type SpawnInput, type SpawnPlan, type SpawnSource } from "../spawn/plan.ts";
import { DEFAULT_SIZE, isSize, type Size } from "../spawn/sizes.ts";
import { DEFAULT_MODE } from "../spawn/chain.ts";
import { linkAppAtBirth, type AppEntry } from "../spawn/app_links.ts";
import { requireUser } from "./access.ts";

export interface Spawned {
  readonly name: string;
  readonly org: string;
  readonly url: string;
  readonly bodyId: string;
  /** Where the child runs: in this process, or as a process in its own cell. */
  readonly placement: PlacementKind;
  /** True when this call found the child already made and changed nothing. */
  readonly existed: boolean;
  /**
   * The link that hands the child to its person: shown once, here, when
   * the child is made. Absent when the child already existed; the child
   * keeps only its hash (`spawn/claim.ts`).
   */
  readonly claimUrl?: string;
}

export type SpawnError =
  | { readonly kind: "unauthorized" | "forbidden" | "cross_origin" }
  | { readonly kind: "invalid"; readonly field: string; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string; readonly message: string }
  | { readonly kind: "exists"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface SpawnDeps {
  readonly placement: Placement;
  /** The request that asked, for the same-origin check on this mutation. */
  readonly request: Request;
  readonly url: URL;
  /** The plan was given by a gift code the caller has already claimed (`actions/codes.ts`): no admin, no payment. */
  readonly gift?: boolean;
  /**
   * The child's own model key, when the spawner gives it one: an API key, or
   * a person's own setup-token under a budget (their choice), sealed in the child with the
   * child's own `secret.key`, granted to its organisation, and never shown
   * again or kept by the parent. Its whole-life budget is the plan's
   * `budgetUsd`, locked in the child.
   */
  readonly modelKey?: string;
  /** Anthropic-compatible API base URL sealed with the starter key (OpenRouter, etc.). */
  readonly modelEndpoint?: string;
  /** The nightly drill's own forge: its spawn events carry `drill`, so the boards keep it as its own series. */
  readonly drill?: boolean;
}

interface Ledger {
  readonly name: string;
  readonly bodyId: string;
  readonly url: string;
  readonly planHash: string;
  done: boolean;
  /** For the client list (#776); absent on a ledger written before it. */
  readonly forWhom?: string;
  readonly apps?: readonly string[];
  readonly createdAt?: string;
  /** The person who made it, counted against their forges (`spawn/sleep.ts`); absent for a stranger's. */
  readonly ownerId?: string;
  /** Absent on a ledger written before sizes; reads as small. */
  readonly size?: Size;
  /** The template chosen (`spawn/templates.ts`); absent means `blank`. */
  readonly template?: string;
  /** The plan chosen (`settings/plans.ts`); absent means the free plan. */
  readonly plan?: string;
  /** Absent on a ledger written before cells; reads as hosted. */
  readonly placement?: PlacementKind;
  /** Why a child that wanted a cell is hosted instead (`spawn/host.ts`). */
  readonly placementNote?: string;
  /**
   * What the parent shows the child to learn its private facts (when anything
   * last happened); the child keeps only its hash. Never in an answer.
   */
  statusToken?: string;
  /**
   * The key a child signs its heartbeats with (`spawn/heartbeat.ts`); the
   * child holds the same one in its `parent.json`. Never in an answer.
   */
  beatKey?: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** The name the child's sealed model key goes by. */
export const STARTER_KEY = "starter";
const inFlight = new Set<string>();
/** Whether a child of this name is being made right now. */
export const beingMade = (name: string): boolean => inFlight.has(name);

/** A failure the boards count: the step that broke (a fixed few), never its words. */
function failed(app: App, deps: SpawnDeps, step: "place" | "copy" | "health", message: string) {
  app.bus.append({ kind: "forge.spawn.failed", payload: { step, ...(deps.drill === true ? { drill: 1 } : {}) } });
  return fail(message);
}

const fail = (message: string) => err<SpawnError>({ kind: "failed", message });

export const childDirOf = (app: App, bodyId: string): string =>
  join(app.config.dataDir, "children", bodyId);
const ledgerPath = (app: App, name: string): string =>
  join(app.config.dataDir, "spawn", `${name}.json`);

/** Live child URL from name + the parent's origin (ignores stale ledger.url), so old subdomain ledgers still resolve. */
export const liveChildUrl = (app: App, name: string): string =>
  childPublicUrl(name, parentOrigin(app.config));

/** A ledger file's text as a `Ledger`, or undefined when it is not JSON or lacks name, bodyId and done: the one check every reader shares. */
export function parseLedger(text: string): Ledger | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.bodyId !== "string" || typeof o.done !== "boolean") return undefined;
  return v as Ledger;
}

async function readLedger(app: App, name: string): Promise<Ledger | undefined> {
  const file = Bun.file(ledgerPath(app, name));
  if (!(await file.exists())) return undefined;
  try {
    return parseLedger(await file.text());
  } catch {
    return undefined;
  }
}

async function writeLedger(app: App, ledger: Ledger): Promise<void> {
  await mkdir(join(app.config.dataDir, "spawn"), { recursive: true });
  const path = ledgerPath(app, ledger.name);
  await Bun.write(`${path}.tmp`, JSON.stringify(ledger));
  await rename(`${path}.tmp`, path);
}

/**
 * The child's founder account: the spawner's own name, or a placeholder
 * for a stranger's child (`copyInto`).
 */
export const founderNameOf = (owner: User | undefined): string => owner?.username ?? PLACEHOLDER_FOUNDER;

/**
 * A child whose organisation would take its founder's name can't be made:
 * the founder is created first and holds the name, so the organisation
 * would fail `name_taken` after the body was placed. Said here, so the
 * dry run refuses what the spawn would fail on.
 */
export function founderClash(
  plan: { readonly name: string; readonly org: string },
  owner: User | undefined,
): { field: "name" | "org"; reason: string } | undefined {
  const founder = founderNameOf(owner);
  if (plan.org.toLowerCase() !== founder.toLowerCase()) return undefined;
  return {
    field: plan.org === plan.name ? "name" : "org",
    reason: `${plan.org} is the name of the child's founder account (${owner === undefined ? "a stranger's child starts with one" : "yours"}); its organisation needs another name`,
  };
}

export async function spawnForge(
  app: App,
  actor: User | undefined,
  input: SpawnInput,
  source: SpawnSource,
  deps: SpawnDeps,
): Promise<Result<Spawned, SpawnError>> {
  if (crossOrigin(deps.request, deps.url, app.log)) return err({ kind: "cross_origin" });
  // A stranger may spawn (and claim) a child; an agent may not. A signed-in
  // person is the owner of record; a stranger's child names no owner until
  // it is claimed.
  let owner: User | undefined;
  if (actor !== undefined) {
    const user = requireUser(actor);
    if (!user.ok) return err({ kind: "unauthorized" });
    if (user.value.kind !== "user") return err({ kind: "forbidden" });
    owner = user.value;
  }

  // The dry-run is not trusted: the plan is made again, here.
  const planned = planSpawn(input, source);
  if (!planned.ok) return err({ kind: "invalid", ...planned.error });
  const plan = planned.value;
  // Before anything is placed: a clash would leave a half-made child.
  const clash = founderClash(plan, owner);
  if (clash !== undefined) return err({ kind: "invalid", ...clash });

  const names = new Set<string>();
  for (const a of plan.apps) {
    const name = a.ref.split("/")[1]!;
    if (names.has(name.toLowerCase()))
      return err({ kind: "invalid", field: "apps", reason: `two apps are named ${name}` });
    names.add(name.toLowerCase());
    const [o, n] = a.ref.split("/") as [string, string];
    const repo = getRepo(app.db, o, n);
    if (!repo || !canRead(app.db, repo, owner))
      return err({ kind: "invalid", field: "apps", reason: `${a.ref} is not readable by you` });
  }
  for (const b of plan.briefs) {
    if (b.text.length > BRIEF_MAX)
      return err({ kind: "invalid", field: "briefs", reason: `a brief is at most ${BRIEF_MAX} characters` });
  }

  if (inFlight.has(plan.name)) return err({ kind: "exists", message: "that child is being made" });
  inFlight.add(plan.name);
  try {
    return await make(app, owner, plan, deps);
  } finally {
    inFlight.delete(plan.name);
  }
}

async function make(
  app: App,
  owner: User | undefined,
  plan: SpawnPlan,
  deps: SpawnDeps,
): Promise<Result<Spawned, SpawnError>> {
  // The key as the person meant it: whitespace and a `Bearer ` prefix from the paste dropped.
  if (deps.modelKey !== undefined) deps = { ...deps, modelKey: normalizeToken(deps.modelKey) };
  const planHash = sha256(JSON.stringify(plan));
  let ledger = await readLedger(app, plan.name);
  if (ledger) {
    if (ledger.planHash !== planHash)
      return err({ kind: "exists", message: `a different child named ${plan.name} already exists` });
    // The plan names that there is a key, never which: a retry with another
    // key is refused plainly rather than quietly keeping the first.
    if (deps.modelKey !== undefined) {
      const held = heldKey(childDirOf(app, ledger.bodyId));
      if (held !== undefined && held !== deps.modelKey)
        return err({
          kind: "exists",
          message: `${plan.name} was already given a different model key; a key is given once`,
        });
    }
    if (ledger.done)
      return ok({ name: plan.name, org: plan.org, url: liveChildUrl(app, plan.name), bodyId: ledger.bodyId, placement: ledger.placement ?? "hosted", existed: true });
    if (ledger.statusToken === undefined || ledger.beatKey === undefined) {
      ledger.statusToken ??= secret();
      ledger.beatKey ??= secret();
      await writeLedger(app, ledger);
    }
    // A retry of an unfinished child is a new attempt: its failure has a start.
    app.bus.append({ kind: "forge.spawn.started", payload: { ...(deps.drill === true ? { drill: 1 } : {}) } });
  } else {
    // A paid plan is held to its own count, never the free one; the free plan keeps today's per-person limits.
    const chosen = plan.plan === undefined ? undefined : getPlan(app.db, plan.plan);
    if (plan.plan !== undefined && chosen === undefined)
      return err({ kind: "invalid", field: "plan", reason: `${plan.plan} is not a plan this forge offers` });
    if (chosen !== undefined && chosen.key !== FREE && deps.gift === true) {
      // A redeemed gift code (`actions/codes.ts`) or a paid order (`actions/order.ts`) is what lends this plan: it asks no admin.
    } else if (chosen !== undefined && chosen.key !== FREE) {
      if (owner === undefined) return err({ kind: "refused", reason: "plan", message: `the ${chosen.name} plan is for a signed-in person; sign in first` });
      if (!owner.isAdmin) return err({ kind: "refused", reason: "plan", message: PAID_PLAN_ADMIN_ONLY(chosen.name) });
      const many = planRefusal(app.config.dataDir, owner, chosen, FREE);
      if (many !== undefined) return err({ kind: "refused", reason: "quota", message: many });
    } else if (owner !== undefined) {
      const many = personRefusal(app.db, app.config.dataDir, owner);
      if (many !== undefined) return err({ kind: "refused", reason: "quota", message: many });
    }
    const over = quotaRefusal(app.config.dataDir, plan.size ?? DEFAULT_SIZE);
    if (over !== undefined) return err({ kind: "refused", reason: "quota", message: over });
    const placed = await deps.placement.place(plan);
    if (!placed.ok) return err({ kind: "refused", ...placed.error });
    if (!SAFE_ID.test(placed.value.bodyId)) {
      await deps.placement.retire(placed.value.bodyId);
      return failed(app, deps, "place", "placement returned an unusable body id");
    }
    ledger = {
      name: plan.name,
      bodyId: placed.value.bodyId,
      url: placed.value.url,
      planHash,
      done: false,
      ...(plan.forWhom === undefined ? {} : { forWhom: plan.forWhom }),
      apps: plan.apps.map((a) => a.ref),
      createdAt: new Date().toISOString(),
      ...(owner === undefined ? {} : { ownerId: owner.id }),
      size: plan.size ?? DEFAULT_SIZE,
      ...(plan.template === undefined ? {} : { template: plan.template }),
      ...(plan.plan === undefined ? {} : { plan: plan.plan }),
      placement: placed.value.kind ?? "hosted",
      statusToken: secret(),
      beatKey: secret(),
    };
    await writeLedger(app, ledger);
    app.bus.append({ kind: "forge.spawn.started", payload: { ...(deps.drill === true ? { drill: 1 } : {}) } });
  }

  const copied = await copyInto(app, owner, plan, ledger, deps.modelKey, deps.modelEndpoint);
  if (!copied.ok) return failed(app, deps, "copy", copied.error);
  const claimUrl = claimLink(liveChildUrl(app, plan.name), copied.value);
  // A plan carries its own credit (grantPlanCredit); the included credit is for a spawn on no plan.
  if (plan.plan === undefined) lendIncludedCredit(app, plan.name, childDirOf(app, ledger.bodyId), deps.modelKey !== undefined);

  grantPlanCredit(app, plan, ledger.bodyId);
  ledger.done = true;
  await writeLedger(app, ledger);
  tellPlan(app, plan.name);
  app.bus.append({
    kind: "forge.spawned",
    actorId: owner?.id,
    payload: { name: plan.name, org: plan.org, url: liveChildUrl(app, plan.name), apps: plan.apps.map((a) => a.ref) },
  });
  return ok({
    name: plan.name,
    org: plan.org,
    url: liveChildUrl(app, plan.name),
    bodyId: ledger.bodyId,
    placement: ledger.placement ?? "hosted",
    existed: false,
    claimUrl,
  });
}

/**
 * The crew credit the child's plan carries, read now (so an edit on the plans
 * page is what the next spawn gets): lent as a monthly cap, the spend counted
 * again each calendar month (`spawn/credit.ts`). A plan with no credit lends
 * none. A hand-off that cannot reach the child leaves it unfunded, and an
 * admin can lend by hand (`PUT /api/v1/forges/:name/credit`).
 */
export function grantPlanCredit(app: App, plan: SpawnPlan, bodyId: string): void {
  const chosen = plan.plan === undefined ? undefined : getPlan(app.db, plan.plan);
  if (chosen === undefined || !(chosen.creditUsd > 0)) return;
  const dir = childDirOf(app, bodyId);
  const set = setCap(app, plan.name, chosen.creditUsd, fundingOf(dir) !== undefined, (token, credit) =>
    keepFunding(dir, { token, capUsd: credit.capUsd, spentUsd: credit.spentUsd }),
    true,
  );
  if (set === undefined || set === "unreachable") app.log.warn(`plan credit not lent to ${plan.name}`);
  else app.bus.append({ kind: "forge.credit_set", payload: { name: plan.name, usd: set.capUsd, plan: chosen.key } });
}

/**
 * Every step skips what is already there, so a resumed child is finished,
 * not doubled. Answers the child's claim token, minted afresh each time.
 */
async function copyInto(
  app: App,
  owner: User | undefined,
  plan: SpawnPlan,
  ledger: Ledger,
  modelKey: string | undefined,
  modelEndpoint: string | undefined,
): Promise<Result<string, string>> {
  const dir = childDirOf(app, ledger.bodyId);
  await mkdir(dir, { recursive: true });
  const child = createApp({ dataDir: dir });
  try {
    // The founder is a name only: no password, no email worth mailing. The
    // child's first boot hands the account to a person (#422). A stranger's
    // child gets a placeholder; the claim names the real admin.
    const founderName = founderNameOf(owner);
    const founder =
      getUserByName(child.db, founderName) ??
      (await (async () => {
        const made = await createUser(child.db, {
          username: founderName,
          email: `${founderName}@spawn.forge.invalid`,
          // Seeded by the parent's owner, who is proven there, under the
          // name they already hold there.
          trusted: true,
          allowReserved: true,
          origin: "spawn",
        });
        return made.ok ? made.value : undefined;
      })());
    if (!founder) return err("could not make the child's founder");
    // A member, not a guest: the child's first boot acts as the founder to
    // open the direction and hand it to the planner, which starts a run.
    setMember(child.db, founder.id, true, founder.id, new Date());

    let org = getOrg(child.db, plan.org);
    if (!org) {
      // Named by the spawner, who was held to the rule on the parent.
      const made = createOrg(child.db, plan.org, founder.id, { allowReserved: true });
      if (!made.ok) return err(`could not make org ${plan.org}: ${made.error}`);
      org = made.value;
    }

    let templateMark: TemplateMark | undefined;
    const copiedRepos: { parent: Repo; child: Repo }[] = [];
    // Each app's link to the parent's repository: the whole history is copied below, and the
    // child follows it from the first minute (`spawn/app_links.ts`).
    const appEntries: AppEntry[] = [];
    for (const a of plan.apps) {
      const [o, n] = a.ref.split("/") as [string, string];
      const parent = getRepo(app.db, o, n);
      if (!parent) return err(`${a.ref} is gone`);
      let repo = getRepo(child.db, org.username, n);
      if (!repo) {
        const made = await createRepo(child.db, child.reposRoot, {
          ownerId: org.id,
          name: n,
          visibility: parent.visibility,
          description: parent.description,
          defaultBranch: parent.defaultBranch,
        });
        if (!made.ok) return err(`could not make ${a.ref}: ${made.error}`);
        repo = made.value;
      }
      // Branches and tags with every commit behind them; re-running only tops up.
      const fetched = await runGit(
        [
          "fetch",
          "--no-write-fetch-head",
          repoDir(app.reposRoot, o, n),
          "+refs/heads/*:refs/heads/*",
          "+refs/tags/*:refs/tags/*",
        ],
        { cwd: repoDir(child.reposRoot, org.username, n), timeoutMs: 600_000 },
      );
      if (!fetched.ok) return err(`could not copy ${a.ref}: ${fetched.error.stderr}`);
      // The spawner's words are each app's direction; the child's first
      // boot opens the direction issue from them (`spawn/first-boot.ts`).
      if (plan.direction !== "" && repo.autonomyDirection !== plan.direction)
        repo = updateRepoSettings(child.db, repo, { autonomyDirection: plan.direction });
      appEntries.push(
        await linkAppAtBirth(app, child, dir, {
          org: org.username,
          upstream: a.ref,
          parent,
          repo,
          by: founder,
          name: plan.name,
          url: liveChildUrl(app, plan.name),
          ownerId: owner?.id,
          mode: plan.followMode ?? DEFAULT_MODE,
        }),
      );
      copiedRepos.push({ parent, child: repo });
    }

    // A fresh app, begun from the spawner's sentence: a README and the
    // smallest app that answers, committed once.
    // With a template, the sentence describes the template's app instead:
    // one repository, not two (`spawn/template_birth.ts`).
    if (plan.template !== undefined) {
      const born = await birthFromTemplate(child, org, {
        template: plan.template,
        ...(plan.fresh === undefined ? {} : { fresh: plan.fresh }),
        direction: plan.direction,
        taken: new Set(plan.apps.map((a) => a.ref.split("/")[1]!)),
      });
      if (!born.ok) return err(born.error);
      templateMark = born.value;
    } else if (plan.fresh !== undefined) {
      const made = await startFresh(child, org, plan.fresh, plan.direction);
      if (!made.ok) return err(made.error);
    }

    // The forge's own code, forked into the child with its full history,
    // so every child starts from the forge and can follow its parent.
    // A cross-forge fork: the history is copied by git, and the upstream
    // is recorded in parent.json for the child to pull from. Skipped when
    // the forge does not name its code repository (`forgeRepo`).
    const forgeCode = await forkForgeCode(app, child, org.username, plan.followMode ?? DEFAULT_MODE);
    if (!forgeCode.ok) return err(forgeCode.error);

    for (const b of plan.briefs) {
      // The jobs it declares travel with it (#8907).
      const roles = getAgentByName(app.db, b.agent)?.roles;
      const existing = getAgentByName(child.db, b.agent);
      if (existing) {
        updateAgent(child.db, existing.user.id, { brief: b.text, ...(roles ? { roles } : {}) });
        continue;
      }
      const made = await createUser(child.db, {
        username: b.agent,
        email: `${b.agent}@agents.spawn.forge.invalid`,
        agent: true,
        origin: "spawn",
      });
      if (!made.ok) return err(`could not make crew member ${b.agent}: ${made.error}`);
      createAgentRow(child.db, { userId: made.value.id, brief: b.text, roles, createdBy: founder.id });
    }

    // A carried crew member keeps its place on each app: the role it had on
    // the parent's copy (planner, builder, reviewer), so the child's planner
    // is known before its first boot.
    for (const { parent, child: repo } of copiedRepos)
      for (const { agent, role } of listCrewRoles(app.db, parent.id)) {
        if (!plan.briefs.some((b) => b.agent === agent.user.username)) continue;
        const theirs = getAgentByName(child.db, agent.user.username);
        if (!theirs) continue;
        addCrew(child.db, repo.id, theirs.user.id, founder.id);
        setCrewRole(child.db, repo.id, theirs.user.id, role);
      }

    // A forge with no crew of its own comes with a builder and a reviewer,
    // seated on its apps with autonomy on (#11154).
    await seedStarterCrew(child.db, org.id, founder.id);

    // The fork is the child's own source: its `forgeRepo`, and the crew seated on it.
    adoptForgeCode(child, org.username, founder.id);

    // The child's own keys, made in its own directory now, so they exist
    // before its first boot and are provably not the parent's: the key that
    // seals its secrets, and its SSH host key.
    loadKey(dir);
    loadOrCreateHostKey(join(dir, "ssh"));

    // A model key the spawner handed over: sealed with the child's key,
    // offered to its organisation's crew, and bound to a whole-life budget
    // the child cannot raise — enforced where every run picks its account,
    // whoever started the run and on whichever repository.
    if (modelKey !== undefined && plan.budgetUsd !== null) {
      const sealed =
        getSubscriptionByName(child.db, STARTER_KEY) ??
        (() => {
          const added = addSubscription(child.db, dir, {
            name: STARTER_KEY,
            token: modelKey,
            ...(modelEndpoint === undefined || modelEndpoint.trim() === ""
              ? {}
              : { apiBase: modelEndpoint }),
            createdBy: founder.id,
          });
          return added.ok ? added.value : undefined;
        })();
      if (!sealed) return err("could not seal the child's model key");
      setGrants(child.db, org.id, "", [sealed.id]);
      if (!lockBudget(child.db, sealed.id, plan.budgetUsd))
        return err("could not set the key's budget");
    }

    const upstream = app.config.url ?? `http://${app.config.host ?? "localhost"}`;
    await Bun.write(
      join(dir, "parent.json"),
      JSON.stringify({
        upstream,
        name: plan.name,
        org: plan.org,
        // The child's own address: <name>--<parent's host>.
        url: liveChildUrl(app, plan.name),
        keepAccess: plan.keepAccess,
        // No spawner signed in: the founder account is a placeholder (#11785).
        anonymous: owner === undefined,
        size: plan.size ?? DEFAULT_SIZE,
        ...(plan.template === undefined ? {} : { template: templateMark ?? { id: plan.template } }),
        // Each app: where it came from and that the child follows it (`spawn/app_links.ts`).
        apps: appEntries,
        ...(plan.fresh === undefined ? {} : { fresh: `${plan.org}/${plan.fresh.name}` }),
        // The forge's code, forked into the child: where it came from, so
        // the child can follow its parent's updates.
        ...(forgeCode.value === undefined
          ? {}
          : { forgeCode: { repo: `${plan.org}/forge`, ...forgeCode.value } }),
        // Only the hash: the parent alone holds what it answers to.
        ...(ledger.statusToken === undefined ? {} : { statusHash: sha256(ledger.statusToken) }),
        // The key the child signs its heartbeats with; the parent holds the same.
        ...(ledger.beatKey === undefined ? {} : { beatKey: ledger.beatKey }),
      }),
    );
    return ok(mintClaim(child.db, org.id));
  } finally {
    child.close();
  }
}

/** The smallest app that runs: answers `/` with the sentence, escaped. */
function freshFiles(description: string): { path: string; content: string }[] {
  const text = JSON.stringify(description);
  const html = JSON.stringify(`<!doctype html><meta charset=utf-8><title>app</title><p>`);
  return [
    { path: "README.md", content: `# A fresh app\n\n${description.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>()#+\-.!|~]/g, "\\$&")}\n` },
    { path: "forge.json", content: JSON.stringify({ app: { run: "bun run index.ts", health: "/" } }, null, 2) + "\n" },
    {
      path: "index.ts",
      content: `const text = ${text};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
Bun.serve({
  port: Number(process.env["PORT"] ?? 3000),
  fetch: () =>
    new Response(${html} + esc(text) + "</p>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
`,
    },
  ];
}

/** A repository in the child's organisation holding a fresh app; a retry finds it and leaves it. */
async function startFresh(
  child: App,
  org: { readonly id: string; readonly username: string },
  fresh: { readonly name: string; readonly description: string },
  direction: string,
): Promise<Result<true, string>> {
  let repo = getRepo(child.db, org.username, fresh.name);
  if (!repo) {
    const made = await createRepo(child.db, child.reposRoot, {
      ownerId: org.id,
      name: fresh.name,
      visibility: "private",
      description: fresh.description,
      defaultBranch: "main",
    });
    if (!made.ok) return err(`could not make ${fresh.name}: ${made.error}`);
    repo = made.value;
  }
  const dir = repoDir(child.reposRoot, org.username, fresh.name);
  const has = await runGit(["rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}`], { cwd: dir });
  if (!has.ok) {
    const c = await commitFiles(dir, {
      branch: repo.defaultBranch,
      message: "A fresh app",
      files: freshFiles(fresh.description),
      author: { name: "forge", email: "forge@spawn.forge.invalid" },
    });
    if (!c.ok) return err(`could not start ${fresh.name}`);
  }
  if (direction !== "" && repo.autonomyDirection !== direction)
    updateRepoSettings(child.db, repo, { autonomyDirection: direction });
  return ok(true);
}

/**
 * The model key a child already holds, opened with the child's own key; or
 * undefined when it has none yet (or the child's database is not there).
 */
function heldKey(dir: string): string | undefined {
  let db: Database | undefined;
  try {
    db = new Database(join(dir, "forge.db"), { readonly: true });
    const row = db
      .query<{ id: string; token_enc: string }, [string]>(
        "SELECT id, token_enc FROM subscription WHERE name = ?1",
      )
      .get(STARTER_KEY);
    if (!row) return undefined;
    const opened = open(dir, row.token_enc, subscriptionAad(row.id));
    return opened.ok ? opened.value : "";
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/**
 * A new claim link for a child nobody has claimed yet (#729): the spawner's
 * — an admin of this forge — when the first went unused or was lost. The
 * child keeps one claim row, so minting replaces it and the old link dies
 * at once. A claimed child (one with a person as admin) is refused.
 */
export async function reissueClaim(
  app: App,
  actor: User | undefined,
  name: string,
  deps: { readonly request: Request; readonly url: URL },
): Promise<Result<{ readonly name: string; readonly claimUrl: string }, SpawnError | { readonly kind: "not_found" }>> {
  if (crossOrigin(deps.request, deps.url, app.log)) return err({ kind: "cross_origin" });
  const user = requireUser(actor);
  if (!user.ok) return err({ kind: "unauthorized" });
  if (!user.value.isAdmin) return err({ kind: "forbidden" });
  const made = await reissueClaimFor(app, name);
  if (made.ok) app.bus.append({ kind: "forge.claim_reissued", actorId: user.value.id, payload: { name } });
  return made;
}

/**
 * A new claim link for an unclaimed child, with no actor: the caller has
 * already decided who may have it (an admin above; the buyer of the forge in
 * `actions/order.ts`). The old link stops working.
 */
export async function reissueClaimFor(
  app: App,
  name: string,
): Promise<Result<{ readonly name: string; readonly claimUrl: string }, SpawnError | { readonly kind: "not_found" }>> {
  const ledger = /^[a-z0-9-]{1,39}$/.test(name) ? await readLedger(app, name) : undefined;
  if (!ledger || !ledger.done) return err({ kind: "not_found" });
  const child = createApp({ dataDir: childDirOf(app, ledger.bodyId) });
  try {
    const spawned = await spawnedOrg(child);
    if (!spawned) return fail("the child has no organisation to claim");
    if (hasAdmin(child.db))
      return err({ kind: "refused", reason: "claimed", message: `${name} is already claimed; ask its owner to invite you` });
    const token = mintClaim(child.db, spawned.org.id);
    return ok({ name, claimUrl: claimLink(liveChildUrl(app, name), token) });
  } finally {
    child.close();
  }
}

/** What this forge shows a child it made to learn its private facts; undefined for an older child. */
export async function statusTokenOf(app: App, name: string): Promise<string | undefined> {
  return (await readLedger(app, name))?.statusToken;
}

/** The key a child of this forge signs heartbeats with; undefined for a name this forge did not make. */
export async function beatKeyOf(app: App, name: string): Promise<string | undefined> {
  return (await readLedger(app, name))?.beatKey;
}

/** One child, as the ledger keeps it. */
export interface Child {
  readonly name: string;
  readonly url: string;
  readonly bodyId: string;
  readonly done: boolean;
  /** Whom it is for; null when unsaid. */
  readonly for: string | null;
  readonly apps: readonly string[];
  /** When it was begun; null on a ledger older than the client list. */
  readonly createdAt: string | null;
  readonly size: Size;
  /** The template it started from; absent when `blank`. */
  readonly template?: string;
  readonly placement: PlacementKind;
  /** Why it is hosted when it asked for a cell; null otherwise. */
  readonly placementNote: string | null;
  /** The person who made it (their id here); absent for a stranger's or a ledger from before it was kept. */
  readonly ownerId?: string;
}

/** One ledger as a `Child`. */
const childOf = (app: App, ledger: Ledger): Child => ({
  name: ledger.name,
  url: liveChildUrl(app, ledger.name),
  bodyId: ledger.bodyId,
  done: ledger.done,
  for: ledger.forWhom ?? null,
  apps: ledger.apps ?? [],
  createdAt: ledger.createdAt ?? null,
  size: isSize(ledger.size) ? ledger.size : DEFAULT_SIZE,
  ...(typeof ledger.template === "string" ? { template: ledger.template } : {}),
  placement: ledger.placement ?? "hosted",
  placementNote: ledger.placementNote ?? null,
  ...(typeof ledger.ownerId === "string" ? { ownerId: ledger.ownerId } : {}),
});

/** One child by name, or undefined when this forge made none of that name. */
export async function childNamed(app: App, name: string): Promise<Child | undefined> {
  const ledger = await readLedger(app, name);
  return ledger === undefined ? undefined : childOf(app, ledger);
}

/** The children this forge has made or begun, from its ledger, by name. */
export async function listChildren(app: App): Promise<Child[]> {
  const dir = join(app.config.dataDir, "spawn");
  const files = await readdir(dir).catch(() => [] as string[]);
  // Every ledger is read at once: one after another, a hundred of them on a cold disk are seconds.
  const names = files.filter((f) => f.endsWith(".json")).sort().map((f) => f.slice(0, -".json".length));
  const ledgers = await Promise.all(names.map((name) => readLedger(app, name)));
  return ledgers.flatMap((ledger) => (ledger ? [childOf(app, ledger)] : []));
}

/** `listChildren`, read at once: for a terminal command that draws in the same turn (one small file per child). */
export function listChildrenNow(app: App): Child[] {
  const dir = join(app.config.dataDir, "spawn");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Child[] = [];
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    let ledger: Ledger | undefined;
    try {
      ledger = parseLedger(readFileSync(join(dir, f), "utf8"));
    } catch {
      ledger = undefined; // unreadable: skipped, as listChildren skips it
    }
    if (ledger) out.push(childOf(app, ledger));
  }
  return out;
}

/**
 * Whether Start my forge would take `name`: the web route's answer and the
 * terminal's. Only a name that passes the shape is looked up in the ledger.
 */
export async function forgeNameVerdict(app: App, name: string): Promise<NameVerdict> {
  const exists = nameShapeVerdict(name) === undefined && (beingMade(name) || (await childNamed(app, name)) !== undefined);
  return nameVerdict(name, exists);
}
