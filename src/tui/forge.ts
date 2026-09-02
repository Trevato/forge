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
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import { App, type Ctx, type Screen } from "./app/app.ts";
import type { Command } from "./app/palette.ts";
import type { SessionOpts, Terminal } from "./term/terminal.ts";
import { Session, type TuiIdentity } from "./session.ts";
import { accountScreen } from "./screens/account.ts";
import { promptScreen } from "./screens/common.ts";
import { dashboardScreen } from "./screens/dashboard.ts";
import { exploreScreen } from "./screens/explore.ts";
import { issuesScreen, newIssueScreen } from "./screens/issues.ts";
import { newPullScreen } from "./screens/newpull.ts";
import { newRepoScreen } from "./screens/newrepo.ts";
import { originsScreen } from "./screens/origins.ts";
import { ownerScreen } from "./screens/owner.ts";
import { repoScreen } from "./screens/repo.ts";
import { settingsScreen } from "./screens/settings.ts";
import { signInScreen } from "./screens/signin.ts";

export { Session, type TuiIdentity };

export function forgeRoot(session: Session): (ctx: Ctx) => Screen {
  return (ctx) => dashboardScreen(session, ctx);
}

/** The repo-scoped palette verbs: a name to ask for, and what to do with it. */
const REPO_VERBS: readonly {
  id: string;
  title: string;
  open: (f: Session, ctx: Ctx, repo: Repo) => Screen;
}[] = [
  { id: "repo", title: "Open a repository", open: repoScreen },
  {
    id: "issues",
    title: "Issues in a repository",
    open: (f, ctx, repo) => issuesScreen(f, ctx, repo, "issue"),
  },
  {
    id: "pulls",
    title: "Pull requests in a repository",
    open: (f, ctx, repo) => issuesScreen(f, ctx, repo, "pull"),
  },
  { id: "new-issue", title: "New issue", open: newIssueScreen },
  { id: "new-pull", title: "New pull request", open: newPullScreen },
  { id: "settings", title: "Repository settings", open: settingsScreen },
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
        id: "explore",
        title: "Explore repositories",
        run: () => ctx.push(exploreScreen(session, ctx)),
      },
      {
        id: "profile",
        title: "Open a profile",
        hint: "username or org",
        run: () =>
          ctx.push(
            askFor(ctx, "Profile", "username", (name) => {
              ctx.push(ownerScreen(session, ctx, name));
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
              ctx.push(verb.open(session, ctx, repo));
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
          run: () => ctx.push(accountScreen(session, ctx)),
        },
        {
          id: "origins",
          title: "Origins",
          hint: "connected forges",
          run: () => ctx.push(originsScreen(session, ctx)),
        },
      );
    commands.push({
      id: "quit",
      title: "Quit",
      hint: "disconnect",
      run: () => ctx.quit(),
    });
    return commands;
  };
}

/** A prompt with no parent to draw behind it — the palette closed already. */
function askFor(
  ctx: Ctx,
  title: string,
  label: string,
  onSubmit: (value: string) => string | undefined,
): Screen {
  const blank: Screen = {
    title,
    keys: [],
    render: () => undefined,
    key: () => false,
  };
  return promptScreen(ctx, blank, { title, label, onSubmit });
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
    root: forgeRoot(session),
    commands: forgeCommands(session),
    onTheme: (name) => session.saveTheme(name),
  });
  return { app, session };
}
