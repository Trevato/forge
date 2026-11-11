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
import { greppable } from "../core/search.ts";
import { guestCodeSearch } from "../http/strangers.ts";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import { nearRepos } from "../core/near_repos.ts";
import { sourceFor } from "../view/source.ts";
import { fleetCommand } from "./screens/fleet.ts";
import { dataCommand } from "./screens/data.ts";
import { packsCommand } from "./screens/packs.ts";
import { getForgeCommand } from "./screens/getforge.ts";
import { startForgeCommand } from "./screens/startforge.ts";
import { pricingCommand } from "./screens/pricing.ts";
import { forgeNameCommand } from "./screens/forgename.ts";
import { workCommand } from "./screens/work.ts";
import { shellsScreen } from "./screens/shells.ts";
import { forkTreeScreen } from "./screens/fork_tree.ts";
import { roadmapScreen } from "./screens/roadmap.ts";
import { spaceScreen } from "./screens/space.ts";
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
  promptScreen,
  blank,
  openOnWeb,
  runAsync,
} from "./screens/common.ts";
import { chainScreen } from "./screens/chain.ts";
import { canSeeMemory } from "../boards/memory.ts";
import { askedScreen } from "./screens/asked.ts";
import { notesScreen } from "./screens/thoughtnotes.ts";
import { deciderScreen } from "./screens/decider.ts";
import { familyScreen } from "./screens/family.ts";
import { familyLines, familyView } from "../spawn/family.ts";
import { issueScreen } from "./screens/issue.ts";
import { pullScreen } from "./screens/pull.ts";
import { blobScreen } from "./screens/repo.ts";
import { dashboardScreen } from "./screens/dashboard.ts";
import { mayManageFlags } from "../core/flags.ts";
import { mayEditTrustedHosts } from "../origins/trusted-hosts.ts";
import { trustedHostsPrompt } from "./screens/trustedhosts.ts";
import { flagsScreen } from "./screens/flags.ts";
import { forgeUsageScreen } from "./screens/forge_usage.ts";
import { usageScreen } from "./screens/usage.ts";
import { canScreen } from "./screens/can.ts";
import { modelScreen } from "./screens/model.ts";
import { notifyScreen } from "./screens/notify.ts";
import { talkBuildScreen } from "./screens/talk_build.ts";
import { talkChatsScreen } from "./screens/talk_chats.ts";
import { sshKeysScreen } from "./screens/sshkeys.ts";
import { passkeysScreen } from "./screens/passkeys.ts";
import { confirmsScreen } from "./screens/confirms.ts";
import { mayTrust, trustedScreen } from "./screens/trusted.ts";
import { proposalTokensPrompt } from "./screens/proposal_tokens.ts";
import { signInsScreen } from "./screens/signins.ts";
import { originAppsScreen } from "./screens/originapps.ts";
import { addEntries } from "./screens/entries.ts";
import { capacityScreen, mayCapacity } from "./screens/capacity.ts";
import { crawlersScreen } from "./screens/crawlers.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { flowLines, flowScreen } from "./screens/flow.ts";
import { readHeld } from "../flow/held.ts";
import { answerKeeper, readKeeper } from "../flow/keeper.ts";
import { readVerified } from "../flow/verified.ts";
import { memoryScreen } from "./screens/system.ts";
import { noteRead, telemetryReader } from "../actions/telemetry.ts";
import { queuesFor, systemFor } from "../system/telemetry.ts";
import { apiScreen } from "./screens/api.ts";
import { changelogScreen } from "./screens/changelog.ts";
import { docsScreen } from "./screens/docs.ts";
import { keeperScreen } from "./screens/keeper.ts";
import { releasesScreen } from "./screens/releases.ts";
import { mayRead } from "../release/gate.ts";
import { fileHoldsPrompt } from "./screens/fileholds.ts";
import { heldScreen } from "./screens/held.ts";
import { stalledScreen } from "./screens/stalled.ts";
import { issuesScreen, newIssueScreen } from "./screens/issues.ts";
import { limbsScreen } from "./screens/limbs.ts";
import { nextScreen } from "./screens/next.ts";
import { findingsScreen } from "./screens/findings.ts";
import { flowsScreen } from "./screens/flows.ts";
import { weekScreen } from "./screens/week.ts";
import { machinesScreen } from "./screens/machines.ts";
import { newPullScreen } from "./screens/newpull.ts";
import { newForgeScreen } from "./screens/newforge.ts";
import { newOrgScreen } from "./screens/neworg.ts";
import { migrateScreen } from "./screens/migrate.ts";
import { bringScreen } from "./screens/bring.ts";
import { openNewApp, templateAppScreen } from "./screens/newapp.ts";
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
    // What the Later gate holds, as /held shows it: reading is the repository's own.
    id: "held",
    title: "Held by the Later gate",
    open: (f, ctx, repo) => heldScreen(f, ctx, repo),
  },
  {
    // The ancestors, siblings and descendants of a repository the person may read.
    id: "fork-tree",
    title: "Fork tree of a repository",
    open: (f, ctx, repo) => forkTreeScreen(f, ctx, repo),
  },
  {
    id: "roadmap",
    title: "Roadmap of a repository",
    open: (f, ctx, repo) => roadmapScreen(f, ctx, repo),
  },
  {
    id: "space",
    title: "Space of a repository",
    open: (f, ctx, repo) => spaceScreen(f, ctx, repo),
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
  {
    // The owner's one ranked list the crew builds from (#8694).
    id: "next-up",
    title: "Next up in a repository",
    open: (f, ctx, repo) => nextScreen(f, ctx, repo),
  },
  {
    // The retrospective the forge wrote at the last weekly reset, and its proposals (#8704).
    id: "week",
    title: "The week in a repository",
    open: (f, ctx, repo) => weekScreen(f, ctx, repo),
  },
  {
    // What flows in and out of a repository, and the radar's key for its admin (#9434).
    id: "flows",
    title: "Flows of a repository",
    open: (f, ctx, repo) => flowsScreen(f, ctx, repo),
  },
  {
    // What code scanning found, and acceptance with a reason for a writer (#9593).
    id: "findings",
    title: "Findings in a repository",
    open: (f, ctx, repo) => findingsScreen(f, ctx, repo),
  },
  {
    // Settings → Machines' other door: the machines and last shell sessions, writers only (#9471).
    id: "machines",
    title: "Machines of a repository",
    open: (f, ctx, repo) => machinesScreen(f, ctx, repo),
  },
  {
    // What the crew's tokens bought on one app, as MCP `returns` with `repo` (#7271).
    id: "repo-usage",
    title: "Usage of a repository",
    open: (f, ctx, repo) => usageScreen(f, ctx, repo),
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
        // The same list as an Atom feed (#10967): the terminal hands over
        // the feed's address, to copy into a reader.
        id: "explore-feed",
        title: "Explore feed",
        hint: "Atom address",
        run: () => openOnWeb(session, ctx, "/explore.atom", "The explore feed"),
      },
      packsCommand(session, ctx),
      getForgeCommand(session, ctx),
      ...startForgeCommand(session, ctx),
      pricingCommand(session, ctx),
      ...forgeNameCommand(session, ctx),
      ...dataCommand(session, ctx),
      fleetCommand(session, ctx),
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
              if (!repo || !canRead(session.db, repo, session.user)) {
                const near = owner && name ? nearRepos(session.db, session.user, owner, name) : [];
                return near.length === 0
                  ? "not found"
                  : `not found — did you mean ${near.map((r) => `${r.ownerName}/${r.name}`).join(", ")}?`;
              }
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
    // The owner's read-only mirrors, as the profile's "work (read-only)" draws them.
    if (session.user !== undefined && session.user.kind !== "agent") commands.push(workCommand(session, ctx));
    // An app from a sentence, as /apps/new makes it: a person's, never an agent's.
    if (session.user !== undefined && session.user.kind !== "agent")
      commands.push({
        id: "new-app",
        title: "New app",
        hint: "say what it does in a sentence; the crew starts on it",
        run: () => openNewApp(session, ctx, blank("New app")),
      });
    // The same from a template repository, as /apps/new?template= does.
    if (session.user !== undefined && session.user.kind !== "agent")
      commands.push({
        id: "new-app-template",
        title: "New app from a template",
        hint: "copy a repository you can read, as the starting files",
        run: () => ctx.push(templateAppScreen(session, ctx, blank("New app"))),
      });
    // An app from another forge, as /bring does: a person's, never an agent's.
    if (session.user !== undefined && session.user.kind !== "agent")
      commands.push({
        id: "bring-app",
        title: "Bring an app",
        hint: "paste a link from another forge; it runs here",
        run: () => ctx.push(bringScreen(session, ctx, blank("Bring an app"))),
      });
    // An organization you own, as /organizations/new and MCP `org_create` make it: a person's, never an agent's (#7260).
    if (session.user !== undefined && session.user.kind !== "agent")
      commands.push({
        id: "new-org",
        title: "New organization",
        hint: "an organization you own, for a client's apps",
        run: () => ctx.push(newOrgScreen(session, ctx)),
      });
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
    // One box to write an idea in, each note with its live state; /notes' own door (#8696).
    if (session.signedIn)
      commands.push({
        id: "thought-notes",
        title: "Notes",
        hint: "write an idea and watch it become shipped work",
        run: () => ctx.push(notesScreen(session, ctx)),
      });
    if (session.signedIn)
      commands.push({
        id: "decider",
        title: "Decider",
        hint: "what it closed, deferred and asked you about today",
        run: () => ctx.push(deciderScreen(session, ctx)),
      });
    // The machine shells this person holds (#10544); an agent holds none.
    if (session.signedIn && session.user?.kind !== "agent")
      commands.push({
        id: "shells",
        title: "Your shells",
        hint: "the machine shells you hold, live then ended",
        run: () => ctx.push(shellsScreen(session, ctx)),
      });
    // Where a decision finds the owner; an agent is never offered it.
    if (session.signedIn && session.user?.kind !== "agent")
      commands.push({
        id: "notify",
        title: "Phone notifications",
        hint: "where the crew reaches your phone; s sets, x turns off",
        run: () => ctx.push(notifyScreen(session, ctx)),
      });
    // What the forge's agent asked first, waiting for the person's yes (#7650).
    if (session.signedIn && session.user?.kind !== "agent")
      commands.push({
        id: "confirms",
        title: "Confirms",
        hint: "what the forge's agent asked to do; y does it once",
        run: () => ctx.push(confirmsScreen(session, ctx)),
      });
    // Who folds in without a person's review, and the kill switch (#8937): a forge admin's.
    if (session.signedIn && mayTrust(session))
      commands.push({
        id: "trusted",
        title: "Trusted sources",
        hint: "who folds in without review; a trusts, x removes, s stops all, v reverts",
        run: () => ctx.push(trustedScreen(session, ctx)),
      });
    // The forge's agent keeps many conversations, as /talk lists them (#8814).
    if (session.signedIn && session.user?.kind !== "agent")
      commands.push({
        id: "conversations",
        title: "Conversations",
        hint: "your talks with the forge's agent; n starts one, r renames, x archives",
        run: () => ctx.push(talkChatsScreen(session, ctx)),
      });
    // One prompt builds an app; each turn is a version to diff, restore and publish (#11010).
    if (session.signedIn && session.user?.kind !== "agent")
      commands.push({
        id: "build-app",
        title: "Build an app",
        hint: "say what to build; versions, diff, restore and publish. n starts one",
        run: () => ctx.push(talkBuildScreen(session, ctx)),
      });
    if (session.signedIn)
      commands.push({
        id: "ssh-keys",
        title: "Computer keys",
        hint: "list, add and remove the keys that sign in as you",
        run: () => ctx.push(sshKeysScreen(session, ctx)),
      });
    // Settings › Passkeys and MCP `whoami_can kind: passkeys`, read only (#8044).
    if (session.signedIn && session.user?.kind !== "agent")
      commands.push({
        id: "passkeys",
        title: "Passkeys",
        hint: "the passkeys that sign in as you",
        run: () => ctx.push(passkeysScreen(session, ctx)),
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
        // Settings → Connected accounts' OAuth apps and MCP `origin_apps` (#7291).
        {
          id: "origin-apps",
          title: "Connection apps",
          hint: "your OAuth apps for connecting accounts; a adds, d removes",
          run: () => ctx.push(originAppsScreen(session, ctx)),
        },
      );
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
          const keeper = readKeeper(session.db, flowReader.kind === "owner");
          const user = session.user;
          ctx.push(flowScreen(ctx, flowLines(
              session.db,
              new Date(),
              systemFor(session.app, flowReader).duplicates,
              flowReader.kind === "agent" ? { queues: queuesFor(session.app, flowReader, new Date(), { batches: true }) } : undefined,
              readHeld(session.app, flowReader.kind === "owner"),
              forgeCeiling(session.app.config),
              readVerified(session.app, flowReader.kind === "owner"),
              keeper,
              session.app.config.dataDir,
            ), keeper.ask && user ? { ask: keeper.ask, answer: () => answerKeeper(session.app, keeper.ask!.id, user.id) } : undefined));
        },
      });
    // The forge's capacity and guards, as MCP `capacity` gates them: a forge admin who is a person.
    if (mayCapacity(session))
      commands.push({
        id: "capacity",
        title: "Capacity",
        hint: "concurrency and guards, live; e changes a settable one",
        run: () => ctx.push(capacityScreen(session, ctx)),
      });
    // What crawlers cost and who was refused, as GET /api/v1/admin/crawlers: the capacity screen's readers.
    if (mayCapacity(session))
      commands.push({
        id: "crawlers",
        title: "Crawlers",
        hint: "their share of answering time, and who was refused",
        run: () => ctx.push(crawlersScreen(session, ctx)),
      });
    // The forge's API operations, as /api lists them; Enter runs a GET: for anyone.
    commands.push({
      id: "api",
      title: "API",
      hint: "the forge's endpoints; run a GET",
      run: () => ctx.push(apiScreen(session, ctx)),
    });
    // The forge's documentation, as /docs lists it: for anyone.
    commands.push({
      id: "docs",
      title: "Docs",
      hint: "the forge's documentation; Enter reads one",
      run: () => ctx.push(docsScreen(ctx)),
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
    // The release keeper's card (#7557), gated as /releases is.
    if (mayRead(session.app, session.user))
      commands.push({
        id: "keeper",
        title: "Release keeper",
        hint: "what holds the next cut, and each release it cut with its probes",
        run: () => ctx.push(keeperScreen(session, ctx)),
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
    // Settings → Flags, as the page has it: an admin who is not an agent (#1970).
    if (mayManageFlags(session.user))
      commands.push({
        id: "flags",
        title: "Flags",
        hint: "declared flags and their live values",
        run: () => ctx.push(flagsScreen(session, ctx)),
      });
    // Settings → Connected accounts' trusted internal hosts: the same admin gate as the page.
    if (mayEditTrustedHosts(session.user))
      commands.push({
        id: "trusted-hosts",
        title: "Trusted hosts",
        hint: "internal hosts an origin may reach",
        run: () => ctx.push(trustedHostsPrompt(session, ctx, blank("Trusted hosts"))),
      });
    // Usage: the forge's spend for any signed-in user (#8308); the route list stays the page's gate, the same as Flags (#1565).
    if (session.user !== undefined)
      commands.push({
        id: "usage",
        title: "Usage",
        hint: "the forge's spend and headroom; an admin also sees every route",
        run: () => ctx.push(usageScreen(session, ctx)),
      });
    // What the forge spent across the apps you write, as GET /api/v1/usage and MCP `usage` answer.
    if (session.user !== undefined)
      commands.push({
        id: "forge-spend",
        title: "Forge spend",
        hint: "today and the last 24 hours, headroom per subscription",
        run: () => ctx.push(forgeUsageScreen(session, ctx)),
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
    // The caller's own role and row of the roles table, as /settings and `whoami_can` have it (#2304).
    if (session.user !== undefined)
      commands.push({
        id: "can",
        title: "What I can do",
        hint: "your role and what it allows here",
        run: () => ctx.push(canScreen(session, ctx)),
      });
    // Entries that live beside their screen, each at the place it names.
    addEntries(commands, session, ctx);
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
    // A one-letter query greps nothing (#11120), so it takes no slot either.
    const greps = session.user === undefined && greppable(query);
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
  /** How long a toast stays up; a test that reads one after a settle makes it long. */
  readonly toastMs?: number;
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
