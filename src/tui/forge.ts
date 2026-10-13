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
  promptScreen,
  openOnWeb,
} from "./screens/common.ts";
import { issueScreen } from "./screens/issue.ts";
import { pullScreen } from "./screens/pull.ts";
import { blobScreen } from "./screens/repo.ts";
import { dashboardScreen } from "./screens/dashboard.ts";
import { issuesScreen, newIssueScreen } from "./screens/issues.ts";
import { newPullScreen } from "./screens/newpull.ts";
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
              const next = verb.open(session, ctx, repo);
              if (next !== undefined) ctx.push(next);
              return undefined;
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
      commands.push(
        {
          id: "account",
          title: "Account settings",
          run: () => openOnWeb(session, ctx, "/settings", "Account settings"),
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
function forgeSearch(session: Session): (ctx: Ctx) => PaletteSearch {
  return (ctx) => async (query, live, signal) => {
    const found = await search(session.app, session.user, {
      q: query,
      limit: 8,
      live,
    });
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
  onSubmit: (value: string) => string | undefined,
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
