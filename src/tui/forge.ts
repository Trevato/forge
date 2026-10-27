/**
 * The forge, as a terminal application: the root screen, the command palette,
 * and the one function that assembles an `App` for a given identity.
 *
 * Everything below this line is a client. It calls the same actions the JSON
 * API calls and the same access helpers the web pages call, so there is no
 * capability here that a token could not exercise, and no way for a session
 * to see something the web would have hidden.
 */

import type { App as Forge } from "../app.ts";
import { search } from "../actions/search.ts";
import { cleanQuery } from "../core/search.ts";
import { guestCodeSearch } from "../http/strangers.ts";
import { sentinelSummary } from "../crew/sentinel.ts";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import { sourceFor } from "../view/source.ts";
import { App, type Ctx, type Screen } from "./app/app.ts";
import type { Command, PaletteItem, PaletteSearch } from "./app/palette.ts";
import { G } from "./term/screen.ts";
import { fileIcon, icon, type IconName } from "./ui/icons.ts";
import type { SessionOpts, Terminal } from "./term/terminal.ts";
import { Session, type TuiIdentity } from "./session.ts";
import {
  ISSUE_MARK,
  ORIGIN_MARK,
  PULL_MARK,
  errorText,
  pickerScreen,
  promptScreen,
  openOnWeb,
  runAsync,
} from "./screens/common.ts";
import { chainScreen } from "./screens/chain.ts";
import { canSeeMemory } from "../boards/memory.ts";
import { boardsScreen } from "./screens/boards.ts";
import { askedScreen } from "./screens/asked.ts";
import { deciderScreen } from "./screens/decider.ts";
import { forgesScreen } from "./screens/forges.ts";
import { clientRows } from "../spawn/clients.ts";
import { familyScreen } from "./screens/family.ts";
import { familyLines, familyView } from "../spawn/family.ts";
import { issueScreen } from "./screens/issue.ts";
import { pullScreen } from "./screens/pull.ts";
import { blobScreen } from "./screens/repo.ts";
import { dashboardScreen } from "./screens/dashboard.ts";
import { mayManageFlags } from "../core/flags.ts";
import { accessScreen } from "./screens/access.ts";
import { mayEditTrustedHosts } from "../origins/trusted-hosts.ts";
import { trustedHostsPrompt } from "./screens/trustedhosts.ts";
import { flagsScreen } from "./screens/flags.ts";
import { secretsScreen } from "./screens/secrets.ts";
import { scorecardScreen } from "./screens/scorecard.ts";
import { cloudScreen } from "./screens/cloud.ts";
import { crewSplitsScreen } from "./screens/crewsplits.ts";
import { crewHandoverScreen } from "./screens/crewhandover.ts";
import { usageScreen } from "./screens/usage.ts";
import { canScreen } from "./screens/can.ts";
import { peopleScreen } from "./screens/people.ts";
import { modelCeilingPrompt, modelGrantPrompt, modelScreen } from "./screens/model.ts";
import { sshKeysScreen } from "./screens/sshkeys.ts";
import { proposalTokensPrompt } from "./screens/proposal_tokens.ts";
import { invitesScreen } from "./screens/invites.ts";
import { subscriptionsScreen } from "./screens/subscriptions.ts";
import { signInsScreen } from "./screens/signins.ts";
import { quotasScreen } from "./screens/quotas.ts";
import { teamsScreen } from "./screens/teams.ts";
import { domainsScreen } from "./screens/domains.ts";
import { ownerScreen } from "./screens/owner.ts";
import { resilienceScreen } from "./screens/resilience.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { flowLines, flowScreen } from "./screens/flow.ts";
import { readHeld } from "../flow/held.ts";
import { forgeLines, memoryScreen, systemLines, systemScreen } from "./screens/system.ts";
import { readHealth } from "../actions/health.ts";
import { grantable, READS_KEPT, recentReads } from "../core/telemetry.ts";
import { noteRead, setTelemetryGrant, telemetryReader } from "../actions/telemetry.ts";
import { queuesFor, systemFor } from "../system/telemetry.ts";
import { live as liveMachine } from "../system/live.ts";
import { changelogScreen } from "./screens/changelog.ts";
import { releasesScreen } from "./screens/releases.ts";
import { mayRead } from "../release/gate.ts";
import { fileHoldsPrompt } from "./screens/fileholds.ts";
import { stalledScreen } from "./screens/stalled.ts";
import { issuesScreen, newIssueScreen } from "./screens/issues.ts";
import { limbsScreen } from "./screens/limbs.ts";
import { newPullScreen } from "./screens/newpull.ts";
import { newForgeScreen } from "./screens/newforge.ts";
import { migrateScreen } from "./screens/migrate.ts";
import { newRepoScreen } from "./screens/newrepo.ts";
import { repoScreen } from "./screens/repo.ts";
import { signInScreen } from "./screens/signin.ts";
import { local } from "./screens/where.ts";

export { Session, type TuiIdentity };

export function forgeRoot(session: Session): (ctx: Ctx) => Screen {
  return (ctx) => dashboardScreen(session, ctx);
}

/** The repo-scoped palette verbs: a name to ask for, and what to do with it. */
const REPO_VERBS: readonly {
  id: string;
  title: string;
  /** The screen to push, or nothing when the verb hands over to the web. */
  open: (f: Session, ctx: Ctx, repo: Repo) => Screen | undefined;
}[] = [
  {
    id: "repo",
    title: "Open a repository",
    open: (f, ctx, repo) => repoScreen(f, ctx, local(f, repo)),
  },
  {
    id: "issues",
    title: "Issues in a repository",
    open: (f, ctx, repo) => issuesScreen(f, ctx, local(f, repo), "issue"),
  },
  {
    id: "pulls",
    title: "Pull requests in a repository",
    open: (f, ctx, repo) => issuesScreen(f, ctx, local(f, repo), "pull"),
  },
  {
    id: "milestones",
    title: "Milestones in a repository",
    open: (f, ctx, repo) => limbsScreen(f, ctx, repo),
  },
  { id: "new-issue", title: "New issue", open: newIssueScreen },
  { id: "new-pull", title: "New pull request", open: newPullScreen },
  {
    id: "settings",
    title: "Repository settings",
    // One settings page, the web's (#635): the terminal hands over its address.
    open: (f, ctx, repo) => {
      openOnWeb(f, ctx, `/${repo.ownerName}/${repo.name}/settings`, "Settings");
      return undefined;
    },
  },
];

/**
 * The palette. Repo-scoped verbs ask for `owner/name` in a prompt and resolve
 * it through `getRepo` plus the screen's own access checks — a repo you
 * cannot read is reported as not found, exactly as it is everywhere else.
 */
export function forgeCommands(session: Session): (ctx: Ctx) => Command[] {
  return (ctx) => {
    const commands: Command[] = [
      {
        id: "home",
        title: "Home",
        hint: "your repositories",
        run: () => ctx.push(dashboardScreen(session, ctx)),
      },
      {
        // Browsing other people and forges is the web explorer's (#607):
        // the terminal hands over its address.
        id: "explore",
        title: "Explore",
        hint: "on the web",
        run: () => openOnWeb(session, ctx, "/explore", "The explorer"),
      },
      {
        // A person's or an org's page is the web's (#636): the terminal
        // hands over its address.
        id: "profile",
        title: "Open a profile",
        hint: "username or org",
        run: () =>
          ctx.push(
            askFor(ctx, "Profile", "username", (name) => {
              openOnWeb(session, ctx, `/${encodeURIComponent(name)}`, "That profile");
              return undefined;
            }),
          ),
      },
    ];

    for (const verb of REPO_VERBS)
      commands.push({
        id: verb.id,
        title: verb.title,
        hint: "owner/name",
        run: () =>
          ctx.push(
            askFor(ctx, verb.title, "owner/name", (spec) => {
              const [owner, name] = spec.split("/");
              const repo =
                owner && name ? getRepo(session.db, owner, name) : undefined;
              // The palette is a client like any other: a repo you cannot
              // read is "not found", indistinguishable from a typo. Without
              // this check the palette would be a way around `canRead`.
              if (!repo || !canRead(session.db, repo, session.user))
                return "not found";
              // After the prompt has popped itself, or the pop takes the
              // screen just pushed instead (`later` in screens/common.ts).
              return Promise.resolve().then(() => {
                const next = verb.open(session, ctx, repo);
                if (next !== undefined) ctx.push(next);
              });
            }),
          ),
      });

    commands.push(
      session.signedIn
        ? {
            id: "new-repo",
            title: "New repository",
            run: () => ctx.push(newRepoScreen(session, ctx)),
          }
        : {
            id: "signin",
            title: "Sign in",
            run: () =>
              ctx.push(signInScreen(session, ctx, () => ctx.invalidate())),
          },
    );
    if (session.signedIn)
      commands.push({
        id: "migrate",
        title: "Migrate a repository",
        hint: "bring one in from an origin or a URL, pick its branch, put a crew on it",
        run: () => ctx.push(migrateScreen(session, ctx)),
      });
    // A client's forge, as /forges/new makes it: any signed-in person's; the door decides the rest.
    if (session.signedIn)
      commands.push({
        id: "new-forge",
        title: "New forge",
        hint: "spawn a client's forge and get its claim link",
        run: () => ctx.push(newForgeScreen(session, ctx)),
      });
    // What you asked for and what became of it, as /asked says it: a signed-in person's.
    if (session.signedIn)
      commands.push({
        id: "asked",
        title: "Asked",
        hint: "your thoughts and what became of them",
        run: () => ctx.push(askedScreen(session, ctx)),
      });
    if (session.signedIn)
      commands.push({
        id: "decider",
        title: "Decider",
        hint: "what it closed, deferred and asked you about today",
        run: () => ctx.push(deciderScreen(session, ctx)),
      });
    if (session.signedIn)
      commands.push({
        id: "ssh-keys",
        title: "SSH keys",
        hint: "list, add and remove the keys that sign in as you",
        run: () => ctx.push(sshKeysScreen(session, ctx)),
      });
    if (session.signedIn)
      commands.push(
        {
          id: "account",
          title: "Account settings",
          run: () => openOnWeb(session, ctx, "/settings", "Account settings"),
        },
        // Settings → Sessions and MCP `sessions`, in the terminal (#7237).
        {
          id: "signins",
          title: "Signed in",
          hint: "your browsers and tokens; d signs a browser out",
          run: () => ctx.push(signInsScreen(session, ctx)),
        },
      );
    // The forge's own faults, as the board's strip shows them: a site admin's.
    if (session.user?.isAdmin === true)
      commands.push({
        id: "sentinel",
        title: "Sentinel",
        hint: "the forge's open faults",
        run: () =>
          ctx.toast(
            sentinelSummary(session.db) ?? "The sentinel has not hunted yet",
            "default",
          ),
      });
    // The boards, as the page gates them: a site admin who is a person, never an agent (#1817).
    if (session.user?.isAdmin === true && session.user.kind !== "agent")
      commands.push({
        id: "boards",
        title: "Boards",
        hint: "the forge's boards and their panels",
        run: () => ctx.push(boardsScreen(session, ctx)),
      });
    // The forge's RSS beside its JS heap, as /system gates it (#2151).
    if (canSeeMemory(session.user))
      commands.push({
        id: "system-memory",
        title: "System memory",
        hint: "RSS beside the JS heap, hourly for 24 h",
        run: () => ctx.push(memoryScreen(session, ctx)),
      });
    // The pipeline's bottleneck and throughput, as /flow says them: a site admin's (#1554, #1786).
    const flowReader = telemetryReader(session.app, session.user);
    if (flowReader)
      commands.push({
        id: "flow",
        title: "Flow",
        hint: "the pipeline's bottleneck and throughput",
        run: () => {
          if (session.user) noteRead(session.app, session.user, flowReader, "flow");
          ctx.push(flowScreen(ctx, flowLines(
              session.db,
              new Date(),
              systemFor(session.app, flowReader).duplicates,
              flowReader.kind === "agent" ? { queues: queuesFor(session.app, flowReader, new Date(), { batches: true }) } : undefined,
              readHeld(session.app, flowReader.kind === "owner"),
              forgeCeiling(session.app.config),
            )));
        },
      });
    // The machine, as /system says it, and which agents may read it: the owner's, a person (#1789).
    if (session.user?.isAdmin === true && session.user.kind !== "agent") {
      commands.push({
        id: "system",
        title: "System",
        hint: "the machine now: CPU, memory, disks, processes",
        run: () => ctx.push(systemScreen(ctx, [
          ...forgeLines(readHealth(session.app, session.user)),
          "",
          ...systemLines(liveMachine().read()),
        ])),
      });
      commands.push({
        id: "telemetry",
        title: "Telemetry",
        hint: "which agents may read flow and system; enter flips the grant",
        run: () => {
          const actor = session.user;
          const agents = grantable(session.db);
          if (agents.length === 0) return ctx.toast("No agent accounts yet");
          const last = new Map<string, { n: number; what: string; at: string }>();
          for (const r of recentReads(session.db, READS_KEPT).reverse()) {
            last.set(r.username, { n: (last.get(r.username)?.n ?? 0) + 1, what: r.what, at: r.at });
          }
          const readsOf = (name: string): string => {
            const l = last.get(name);
            return l ? `${l.n} read${l.n === 1 ? "" : "s"}, last ${l.what} ${l.at}` : "no reads";
          };
          ctx.push(
            pickerScreen(ctx, blank("Telemetry"), {
              title: "Telemetry: telemetry:read",
              items: agents.map((a) => ({ id: a.username, label: a.username, hint: `${a.granted ? "granted" : "not granted"} · ${readsOf(a.username)}` })),
              onPick: ([name]) => {
                const was = agents.find((a) => a.username === name);
                if (!was) return;
                const done = setTelemetryGrant(session.app, actor, was.username, !was.granted);
                ctx.toast(
                  done.ok ? `${was.username}: telemetry:read ${done.value.on ? "granted" : "revoked"}` : "Could not change the grant",
                  done.ok ? "success" : "attn",
                );
              },
            }),
          );
        },
      });
    }
    // Each THREATS.md protection's standing, as /resilience says it: a site admin's.
    if (session.user?.isAdmin === true)
      commands.push({
        id: "resilience",
        title: "Resilience",
        hint: "each protection green, red or untested",
        run: () => ctx.push(resilienceScreen(session, ctx)),
      });
    // The last releases with their pulls, as /changelog shows them: for anyone.
    commands.push({
      id: "changelog",
      title: "Changelog",
      hint: "the last 30 releases and their pulls",
      run: () => ctx.push(changelogScreen(session, ctx)),
    });
    // The live release and the kept ones, as /releases gates them: a site admin or a reader of FORGE_REPO.
    if (mayRead(session.app, session.user))
      commands.push({
        id: "releases",
        title: "Releases",
        hint: "the live release and the kept ones",
        run: () => ctx.push(releasesScreen(session, ctx)),
      });
    // Stalled flow steps the viewer can unblock, as the home's cards show them (#1807).
    if (session.signedIn)
      commands.push({
        id: "stalled",
        title: "Stalled steps",
        hint: "pulls whose check is red or was never asked for; enter re-runs",
        run: () => ctx.push(stalledScreen(session, ctx)),
      });
    // Hold new work on a file: the settings card's twin, admin-checked by the action itself.
    if (session.signedIn)
      commands.push({
        id: "file-holds",
        title: "Held files",
        hint: "hold new work on a file, release it, or list the holds",
        run: () => ctx.push(fileHoldsPrompt(session, ctx, blank("Held files"))),
      });
    // What outside agents tried, as Settings → Access says it: a site admin's (#1768).
    if (session.user?.isAdmin === true && session.user.kind !== "agent")
      commands.push({
        id: "access",
        title: "Access",
        hint: "what outside agents tried",
        run: () => ctx.push(accessScreen(session, ctx)),
      });
    // Settings → Flags, as the page has it: an admin who is not an agent (#1970).
    if (mayManageFlags(session.user))
      commands.push({
        id: "flags",
        title: "Flags",
        hint: "declared flags and their live values",
        run: () => ctx.push(flagsScreen(session, ctx)),
      });
    // Settings → Secrets, as the page has it: a forge admin; names only, never a value.
    if (session.user?.isAdmin === true)
      commands.push({
        id: "secrets",
        title: "Secrets",
        hint: "sealed secrets by name; set or remove one",
        run: () => ctx.push(secretsScreen(session, ctx)),
      });
    // Settings → Origins' trusted internal hosts: the same admin gate as the page.
    if (mayEditTrustedHosts(session.user))
      commands.push({
        id: "trusted-hosts",
        title: "Trusted hosts",
        hint: "internal hosts an origin may reach",
        run: () => ctx.push(trustedHostsPrompt(session, ctx, blank("Trusted hosts"))),
      });
    // Settings → Usage, as the page has it: the same gate as Flags (#1565).
    if (mayManageFlags(session.user))
      commands.push({
        id: "usage",
        title: "Usage",
        hint: "every route, unused ones first",
        run: () => ctx.push(usageScreen(session, ctx)),
      });
    // Settings → Crew's scorecard by model and prompt version: an admin (#2682).
    if (session.user?.isAdmin === true)
      commands.push({
        id: "crew-scorecard",
        title: "Crew scorecard",
        hint: "agent runs per model and per prompt version",
        run: () => ctx.push(crewSplitsScreen(session, ctx)),
      });
    // Settings → Crew's hand-overs: issues parked twice, the last restore drill.
    if (session.user?.isAdmin === true)
      commands.push({
        id: "crew-handover",
        title: "Crew hand-overs",
        hint: "issues parked twice, and the last restore drill",
        run: () => ctx.push(crewHandoverScreen(session, ctx)),
      });
    // Settings → Crew's scorecard per agent, as the page has it: a forge admin (#2677).
    if (session.user?.isAdmin === true)
      commands.push({
        id: "scorecard",
        title: "Crew scorecard per agent",
        hint: "each agent's pulls landed, review rounds, red checks, reverts, time to land",
        run: () => ctx.push(scorecardScreen(session, ctx)),
      });
    // Proposal tokens for a repository you write, as the API and MCP have them (#2148).
    if (session.user !== undefined)
      commands.push({
        id: "proposal-tokens",
        title: "Proposal tokens",
        hint: "mint, list and revoke what a child proposes with",
        run: () => ctx.push(proposalTokensPrompt(session, ctx, blank("Proposal tokens"))),
      });
    // Settings → Model: a person's own budget and subscription, as the page has them (#1145).
    if (session.user?.kind === "user")
      commands.push({
        id: "model",
        title: "Model budget",
        hint: "what your crew may spend, and add your own subscription",
        run: () => ctx.push(modelScreen(session, ctx)),
      });
    // A capped monthly grant to an account: a forge admin who is a person (#1145).
    if (session.user?.isAdmin === true && session.user.kind === "user")
      commands.push({
        id: "model-grant",
        title: "Model grant",
        hint: "give an account dollars a month, or take it back",
        run: () => ctx.push(modelGrantPrompt(session, ctx, blank("Model grant"))),
      });
    if (session.user?.isAdmin === true && session.user.kind === "user")
      commands.push({
        id: "model-ceiling",
        title: "Model ceiling",
        hint: "set an account's dollars a day and a run",
        run: () => ctx.push(modelCeilingPrompt(session, ctx, blank("Model ceiling"))),
      });
    // The caller's own role and row of the roles table, as /settings and `whoami_can` have it (#2304).
    if (session.user !== undefined)
      commands.push({
        id: "can",
        title: "What I can do",
        hint: "your role and what it allows here",
        run: () => ctx.push(canScreen(session, ctx)),
      });
    // Guests, members and admins, as /settings/people has them (#2301).
    if (session.user?.isAdmin === true && session.user.kind === "user")
      commands.push({
        id: "people",
        title: "People",
        hint: "who is a guest, a member or an admin; promote or demote",
        run: () => ctx.push(peopleScreen(session, ctx)),
      });
    // Account quotas, as /admin/limits has them: an admin who is not an agent (#2191).
    if (session.user?.isAdmin === true && session.user.kind !== "agent")
      commands.push({
        id: "quotas",
        title: "Account quotas",
        hint: "what one account may own, and who changed it",
        run: () => ctx.push(quotasScreen(session, ctx)),
      });
    // Crew teams, as /settings/teams has them: an admin who is not an agent (#2679).
    if (session.user?.isAdmin === true && session.user.kind !== "agent")
      commands.push({
        id: "teams",
        title: "Crew teams",
        hint: "each team's charter, dial and members",
        run: () => ctx.push(teamsScreen(session, ctx)),
      });
    // Invite links, as /admin/limits has them: an admin who is a person (#2337).
    if (session.user?.isAdmin === true && session.user.kind === "user")
      commands.push({
        id: "invites",
        title: "Invite links",
        hint: "make a single-use link, see which are open, revoke one",
        run: () => ctx.push(invitesScreen(session, ctx)),
      });
    // The crew's Claude subscriptions, as MCP `subscriptions` has them: a forge admin (#7244).
    if (session.user?.isAdmin === true)
      commands.push({
        id: "subscriptions",
        title: "Crew subscriptions",
        hint: "each account's budget and rest; wake one, set its budget",
        run: () => ctx.push(subscriptionsScreen(session, ctx)),
      });
    // Cloud accounts, as Settings → Cloud accounts has them: a forge admin (#2199).
    if (session.user?.isAdmin === true)
      commands.push({
        id: "cloud",
        title: "Cloud accounts",
        hint: "provider tokens, what they are used for, today's calls",
        run: () => ctx.push(cloudScreen(session, ctx)),
      });
    // Each failure domain and its last drill, as Settings → Backups → Failure domains says it (#1945).
    if (session.user?.isAdmin === true && session.user.kind !== "agent")
      commands.push({
        id: "domains",
        title: "Failure domains",
        hint: "failure domains and their last drill",
        run: () => ctx.push(domainsScreen(session, ctx)),
      });
    // What needs the owner: needs, snapshot store, every failure domain (#1236).
    if (session.user?.isAdmin === true && session.user.kind !== "agent")
      commands.push({
        id: "owner",
        title: "Owner's needs",
        hint: "what needs the owner, snapshots, failure domains",
        run: () => ctx.push(ownerScreen(session, ctx)),
      });
    // The forges this one sent, as /forges lists them: an admin's only.
    if (session.user?.isAdmin === true)
      commands.push({
        id: "forges",
        title: "Forges you sent",
        hint: "each forge sent, claimed or not, and its apps",
        run: () =>
          runAsync(ctx, async () => {
            ctx.push(forgesScreen(ctx, await clientRows(session.app)));
          }),
      });
    commands.push({
      id: "family",
      title: "Family",
      hint: "the forge that sent this one, and the forges it sent",
      run: () =>
        runAsync(ctx, async () => {
          const view = await familyView(session.app, session.user?.isAdmin === true);
          ctx.push(familyScreen(ctx, familyLines(view)));
        }),
    });
    commands.push({
      id: "chain",
      title: "Chain",
      hint: "the forges this forge's code descends from, root first",
      run: () =>
        runAsync(ctx, async () => {
          ctx.push(await chainScreen(session.app, session.user, ctx));
        }),
    });
    commands.push({
      id: "quit",
      title: "Quit",
      hint: "disconnect",
      run: () => ctx.quit(),
    });
    return commands;
  };
}

/**
 * The palette's search half: one `search()` call, three sections.
 *
 * Everything the session can reach is in scope — the repos here, the repos
 * cached from every origin they have connected, conversations on both sides,
 * and the code itself through `git grep`. The action decides visibility once,
 * exactly as the web search page and the API do; nothing is filtered here,
 * because a row that reached this function was already allowed to.
 *
 * Enter on an origin repo opens the **live browse**, not a mirror: browse
 * first, mirror if you mean it (`view/source.ts`). A repo somebody else's
 * origin holds is `not_found` for you, and `sourceFor` is what says so.
 */
export function forgeSearch(session: Session): (ctx: Ctx) => PaletteSearch {
  return (ctx) => async (query, live, signal) => {
    // A guest is a stranger with a key: its search greps code under the same
    // limits as the page's and the API's (`http/strangers.ts`), counted
    // under its peer address. Refused, everything but the code is searched.
    const greps = session.user === undefined && cleanQuery(query) !== "";
    const held = greps
      ? guestCodeSearch(session.app, session.identity.remoteAddress)
      : undefined;
    let found;
    try {
      found = await search(session.app, session.user, {
        q: query,
        limit: 8,
        live,
        withCode: held === undefined || held.allowed,
      });
    } finally {
      if (held?.allowed) held.release();
    }
    if (signal.aborted) return [];
    const items: PaletteItem[] = [];
    const set = ctx.icons;
    // The provenance grammar is the dot: filled means "here", hollow means
    // "somebody else's". A Nerd Font session gets the *noun* instead — a
    // repo, an issue, the file's own language mark — because with a real
    // glyph the kind is the more useful half and the section already says
    // where things came from.
    const mark = (nerd: IconName, plain: string): string =>
      set === "nerd" ? icon(nerd, set) : plain;

    for (const hit of found.repos) {
      if (hit.source === "local") {
        items.push({
          id: `repo:${hit.id}`,
          section: "Repos",
          mark: mark("repo", G.dot),
          title: `${hit.owner}/${hit.name}`,
          hint: countsHint(hit.openIssues, hit.openPulls, hit.description),
          run: () => {
            const repo = getRepo(session.db, hit.owner, hit.name);
            if (repo && canRead(session.db, repo, session.user))
              ctx.push(repoScreen(session, ctx, local(session, repo)));
          },
        });
        continue;
      }
      const mirrored =
        hit.mirroredAs === null
          ? ""
          : ` · ${ORIGIN_MARK} mirrored as ${hit.mirroredAs.owner}/${hit.mirroredAs.name}`;
      items.push({
        id: `origin:${hit.originId}:${hit.fullName}`,
        section: "Repos",
        // A hollow dot: this one is not here. The same grammar the where-strip
        // uses on every repo screen, so the mark means one thing everywhere.
        mark: mark("origin", G.ring),
        title: hit.fullName,
        hint: `${countsHint(hit.openIssues, hit.openPulls, hit.description)}${mirrored}`,
        run: () => {
          const opened = sourceFor(session.app, session.user, {
            originId: hit.originId,
            fullName: hit.fullName,
          });
          if (!opened.ok) {
            ctx.toast(errorText(opened.error), "danger");
            return;
          }
          ctx.push(repoScreen(session, ctx, opened.value));
        },
      });
    }

    for (const hit of found.issues) {
      const where =
        hit.source === "local"
          ? `${hit.repo.owner}/${hit.repo.name}`
          : hit.fullName;
      items.push({
        id: `issue:${where}#${hit.number}`,
        section: "Issues & pulls",
        mark:
          hit.kind === "pull"
            ? mark("pull", hit.source === "local" ? G.dot : G.ring)
            : mark("issue", hit.source === "local" ? G.dot : G.ring),
        title: `${where}#${hit.number} ${hit.title}`,
        hint: `${hit.kind} · ${hit.state}`,
        run: () => {
          if (hit.source !== "local") {
            const opened = sourceFor(session.app, session.user, {
              originId: hit.originId,
              fullName: hit.fullName,
            });
            if (!opened.ok) {
              ctx.toast(errorText(opened.error), "danger");
              return;
            }
            ctx.push(issuesScreen(session, ctx, opened.value, hit.kind));
            return;
          }
          const repo = getRepo(session.db, hit.repo.owner, hit.repo.name);
          if (!repo || !canRead(session.db, repo, session.user)) return;
          const src = local(session, repo);
          ctx.push(
            hit.kind === "pull"
              ? pullScreen(session, ctx, src, hit.number)
              : issueScreen(session, ctx, src, hit.number),
          );
        },
      });
    }

    for (const hit of found.code) {
      const where = `${hit.repo.owner}/${hit.repo.name}`;
      items.push({
        id: `code:${where}:${hit.path}:${hit.line}`,
        section: "Code",
        mark: set === "nerd" ? fileIcon(hit.path, set) : G.dot,
        title: `${hit.path}:${hit.line}`,
        hint: `${where} · ${hit.text.trim().slice(0, 60)}`,
        run: () => {
          const repo = getRepo(session.db, hit.repo.owner, hit.repo.name);
          if (!repo || !canRead(session.db, repo, session.user)) return;
          ctx.push(
            blobScreen(
              session,
              ctx,
              local(session, repo),
              repo.defaultBranch,
              hit.path,
            ),
          );
        },
      });
    }
    if (held !== undefined && !held.allowed)
      items.push({
        id: "code:not-searched",
        section: "Code",
        mark: G.ring,
        title: "Code was not searched",
        hint: `${held.why}; retry in ${held.retryAfter}s`,
        run: () => ctx.toast("Sign in to search code without waiting.", "secondary"),
      });
    if (found.codeSkipped)
      items.push({
        id: "code:skipped",
        section: "Code",
        mark: G.ring,
        title: "Some code was not searched",
        hint: "the forge is busy grepping; try again shortly",
        run: () => ctx.toast("Code search is busy; try again shortly.", "secondary"),
      });
    return items;
  };
}

/** `12 issues · 3 pulls · description` — whatever of it there is. */
function countsHint(
  issues: number,
  pulls: number,
  description: string,
): string {
  return [
    issues > 0 ? `${ISSUE_MARK} ${issues}` : "",
    pulls > 0 ? `${PULL_MARK} ${pulls}` : "",
    description,
  ]
    .filter((p) => p !== "")
    .join("  ");
}

/** A screen that draws nothing — the parent a palette-launched modal has. */
function blank(title: string): Screen {
  return { title, keys: [], render: () => undefined, key: () => false };
}

/** A prompt with no parent to draw behind it — the palette closed already. */
function askFor(
  ctx: Ctx,
  title: string,
  label: string,
  onSubmit: (value: string) => string | undefined | Promise<void>,
): Screen {
  return promptScreen(ctx, blank(title), { title, label, onSubmit });
}

export interface ForgeAppOptions extends SessionOpts {
  readonly terminal: Terminal;
}

/** Assemble the terminal app for one identity, theme persistence included. */
export function createForgeApp(
  forge: Forge,
  identity: TuiIdentity,
  options: ForgeAppOptions,
): { app: App; session: Session } {
  const session = new Session(forge, identity);
  const app = new App({
    ...options,
    theme: session.theme(),
    prefs: session.terminalPrefs(),
    root: forgeRoot(session),
    commands: forgeCommands(session),
    search: forgeSearch(session),
    onTheme: (name) => session.saveTheme(name),
    onPrefs: (prefs) => session.savePrefs(prefs),
  });
  return { app, session };
}
