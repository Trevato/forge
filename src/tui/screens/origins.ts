/**
 * Origins in the terminal: the connected accounts, the three ways to connect
 * one, and the picker that turns a remote repository into a local mirror.
 *
 * The device grant is why this screen exists in the shape it does. It is the
 * only connect flow that works with no browser on this machine — the forge
 * shows a short code, a phone types it in somewhere else, and the forge does
 * the polling. Everything here is a client of `actions/origins.ts`: no token
 * ever reaches a cell buffer, and what a session may see is decided by the
 * same `getOriginFor` every other surface goes through.
 */

import {
  connectOrigin,
  disconnectOrigin,
  listRemoteRepos,
  listUserOrigins,
  mirrorRepo,
  pollOAuthConnect,
  registerOriginApp,
  startOAuthConnect,
  syncOriginNow,
} from "../../actions/origins.ts";
import type { OriginRepoRow } from "../../core/origins.ts";
import type { Origin } from "../../origins/types.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { G } from "../term/screen.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState, spinner } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  ago,
  confirmScreen,
  drawList,
  errorText,
  pickerScreen,
  promptScreen,
  runAsync,
  type ListRow,
} from "./common.ts";
import { repoScreen } from "./repo.ts";

/**
 * Push a screen *after* the prompt that asked for it has closed itself.
 *
 * `promptScreen` pops on submit, so pushing straight from `onSubmit` would
 * hand the pop the screen we just pushed. Returning a promise defers the
 * push by a microtask, which is exactly the ordering wanted: prompt closes,
 * next screen opens.
 */
function later(ctx: Ctx, next: () => Screen): Promise<void> {
  return Promise.resolve().then(() => {
    ctx.push(next());
  });
}

/** `codeberg.org` from `https://codeberg.org` — what a person calls a forge. */
export function hostLabel(url: string): string {
  return URL.parse(url)?.host ?? url;
}

/** Healthy, spent, or merely erroring — three words, never a colour alone. */
export function originState(origin: Origin): {
  text: string;
  tone: "success" | "danger" | "attn";
} {
  if (origin.needsReauth) return { text: "needs re-auth", tone: "danger" };
  if (origin.lastError !== "") return { text: "error", tone: "attn" };
  return { text: "healthy", tone: "success" };
}

/** Where an OAuth application must send the browser back to. */
function callbackUri(f: Session): string {
  const host = f.app.config.host ?? "localhost";
  return `http://${host}:${f.app.config.port ?? 3000}/settings/origins/callback`;
}

// ---- the list ----

export function originsScreen(f: Session, ctx: Ctx): Screen {
  let origins: Origin[] = [];
  const state = new ListState();

  const reload = (): void => {
    origins = f.user ? listUserOrigins(f.app, f.user) : [];
    state.clamp(origins.length);
    ctx.invalidate();
  };

  const current = (): Origin | undefined => origins[state.index];

  const screen: Screen = {
    title: "Origins",
    keys: [
      binding(["j", "k"], "move"),
      binding(["c"], "connect"),
      binding(["s"], "sync now"),
      binding(["r"], "repositories"),
      binding(["D"], "disconnect"),
    ],
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (origins.length === 0) {
        emptyState(s, area, c, {
          title: "No origins connected",
          body: "Connect GitHub, Forgejo or Gitea and mirror repositories in.",
          action: "c  connect an origin",
        });
        return;
      }
      drawList(
        s,
        area,
        c,
        state,
        origins.map((origin): ListRow => {
          const health = originState(origin);
          const kind = origin.authKind === "oauth" ? "oauth" : "token";
          return {
            title: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
            secondary: `${kind} · ${health.text}${origin.lastError === "" ? "" : `: ${origin.lastError}`}`,
            meta:
              origin.lastSyncAt === null
                ? "never synced"
                : `synced ${ago(origin.lastSyncAt)}`,
          };
        }),
      );
    },
    key(e) {
      if (state.key(e, origins.length)) return true;
      if (e.key === "c") {
        ctx.push(connectScreen(f, ctx, screen, reload));
        return true;
      }
      if (e.key === "s") {
        const origin = current();
        if (!origin) return true;
        runAsync(ctx, async () => {
          const report = await syncOriginNow(f.app, f.user, origin.id);
          if (!report.ok) ctx.toast(errorText(report.error), "danger");
          else if (report.value.error !== "")
            ctx.toast(report.value.error, "danger");
          else
            ctx.toast(`synced ${report.value.repos} repositories`, "success");
          reload();
        });
        return true;
      }
      if (e.key === "r") {
        const origin = current();
        if (origin) ctx.push(originReposScreen(f, ctx, origin));
        return true;
      }
      if (e.key === "D") {
        const origin = current();
        if (!origin) return true;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Disconnect origin",
            body: [
              `${origin.login} @ ${hostLabel(origin.webUrl)}`,
              "",
              "Mirrors keep everything they have and stop syncing.",
              "The grant is revoked upstream only where the forge allows it.",
            ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Disconnect", variant: "danger" },
            ],
            onChoose: (choice) => {
              if (choice !== 1) return;
              runAsync(ctx, async () => {
                const gone = await disconnectOrigin(f.app, f.user, origin.id);
                if (!gone.ok) ctx.toast(errorText(gone.error), "danger");
                else
                  ctx.toast(
                    gone.value.revokedUpstream
                      ? "disconnected, grant revoked upstream"
                      : "disconnected — revoke the token on the origin too",
                    "success",
                  );
                reload();
              });
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

// ---- connecting ----

/**
 * The chooser. Which flow works is a property of the forge, not a
 * preference, so the three rows say what each one *is* rather than offering
 * them as equals.
 */
function connectScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  done: () => void,
): Screen {
  return pickerScreen(ctx, parent, {
    title: "Connect an origin",
    items: [
      {
        id: "github",
        label: "GitHub",
        hint: "device code — no browser needed here",
      },
      {
        id: "forgejo",
        label: "Forgejo or Gitea",
        hint: "register an app once, then authorize",
      },
      { id: "token", label: "Paste a token", hint: "works anywhere" },
    ],
    onPick: (ids) => {
      const choice = ids[0];
      if (choice === "github") askGithubHost(f, ctx, parent, done);
      else if (choice === "forgejo") startCodeFlow(f, ctx, parent, done);
      else if (choice === "token") startToken(f, ctx, parent, done);
    },
  });
}

function startToken(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  done: () => void,
): void {
  ctx.push(
    promptScreen(ctx, parent, {
      title: "Connect with a token",
      label: "instance",
      placeholder: "github.com",
      onSubmit: (host) => {
        if (host === "") return "an instance is required";
        return later(ctx, () =>
          promptScreen(ctx, parent, {
            title: `Token for ${host}`,
            label: "personal access token",
            // Masked: a terminal is the one surface where somebody is
            // routinely looking over your shoulder.
            mask: true,
            hint: "Needs repository and issue access. Never displayed again.",
            onSubmit: (token) => {
              if (token === "") return "a token is required";
              return (async () => {
                const connected = await connectOrigin(f.app, f.user, {
                  host,
                  token,
                });
                if (!connected.ok) {
                  ctx.toast(errorText(connected.error), "danger");
                  return;
                }
                ctx.toast(
                  `connected ${connected.value.login} @ ${hostLabel(connected.value.webUrl)}`,
                  "success",
                );
                done();
              })();
            },
          }),
        );
      },
    }),
  );
}

/**
 * Which GitHub. Empty means github.com, which is what almost everyone wants
 * and one keypress away; a host is how GitHub Enterprise gets named, since
 * it publishes nothing discovery could recognise.
 */
function askGithubHost(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  done: () => void,
): void {
  ctx.push(
    promptScreen(ctx, parent, {
      title: "Connect GitHub",
      label: "host",
      placeholder: "github.com — or a GitHub Enterprise host",
      // No `later` here: the device start awaits the network before it
      // pushes anything, so the prompt has already closed by then.
      onSubmit: (host) => {
        startDevice(f, ctx, parent, host === "" ? "github" : host, done);
        return undefined;
      },
    }),
  );
}

function startDevice(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  host: string,
  done: () => void,
): void {
  runAsync(ctx, async () => {
    const started = await startOAuthConnect(f.app, f.user, {
      host,
      kind: "github",
      redirectUri: callbackUri(f),
    });
    if (!started.ok) {
      ctx.toast(started.error.message, "danger");
      return;
    }
    ctx.push(deviceScreen(f, ctx, parent, started.value, done));
  });
}

/**
 * The device-code screen: the code, where to type it, and a spinner while
 * the forge polls on the user's behalf. Esc cancels — the flow row expires
 * on its own, so abandoning it costs nothing.
 */
function deviceScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  flow: { flowId: string; userCode: string; url: string; intervalSecs: number },
  done: () => void,
): Screen {
  let detail = "waiting for you to authorize…";
  let finished = false;

  return {
    title: "Connect GitHub",
    keys: [binding(["esc"], "cancel")],
    load(signal) {
      const every = Math.max(1, flow.intervalSecs) * 1000;
      const timer = setInterval(() => {
        if (finished) return;
        void (async () => {
          const polled = await pollOAuthConnect(f.app, f.user, flow.flowId);
          if (!polled.ok || finished) return;
          if (polled.value.status === "pending") return;
          finished = true;
          clearInterval(timer);
          if (polled.value.status === "done") {
            ctx.toast("origin connected", "success");
            done();
            ctx.pop();
            return;
          }
          detail = polled.value.detail || "that connect failed";
          ctx.toast(detail, "danger");
          ctx.invalidate();
        })();
      }, every);
      signal.addEventListener("abort", () => clearInterval(timer));
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      parent.render(area, s);
      const w = Math.min(60, Math.max(24, area.w - 6));
      const h = Math.min(area.h, 11);
      const inner = card(
        s,
        {
          x: area.x + ((area.w - w) >> 1),
          y: area.y + ((area.h - h) >> 1),
          w,
          h,
        },
        c,
        { title: "Connect GitHub", focused: true },
      );
      const right = inner.x + inner.w;
      s.text(
        inner.x,
        inner.y,
        truncate("Type this code at", inner.w),
        style(c.mutedFg, c.card),
        right,
      );
      s.text(
        inner.x,
        inner.y + 1,
        truncate(flow.url, inner.w),
        style(c.accent, c.card),
        right,
      );
      // The code is the whole point of the screen, so it gets the one
      // deliberately loud line in the terminal UI: spaced out, centred.
      const code = [...flow.userCode].join(" ");
      s.text(
        inner.x + Math.max(0, (inner.w - code.length) >> 1),
        inner.y + 3,
        truncate(code, inner.w),
        style(c.fg, c.card),
        right,
      );
      const x = spinner(s, inner.x, inner.y + 5, c, ctx.tick);
      s.text(
        x + 1,
        inner.y + 5,
        truncate(detail, Math.max(0, right - x - 1)),
        style(c.mutedFg, c.card),
        right,
      );
      s.text(
        inner.x,
        inner.y + 7,
        truncate("esc  cancel", inner.w),
        style(c.faint, c.card),
        right,
      );
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        finished = true;
        ctx.pop();
      }
      return true;
    },
  };
}

/**
 * Forgejo and Gitea: register an application on the instance, then authorize
 * in a browser. There is no device grant to fall back on — their token
 * endpoints accept only `authorization_code` and `refresh_token` — so the
 * terminal prints the URL and waits for the origin list to grow.
 */
function startCodeFlow(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  done: () => void,
): void {
  const redirect = callbackUri(f);
  ctx.push(
    promptScreen(ctx, parent, {
      title: "Connect Forgejo or Gitea",
      label: "instance",
      placeholder: "codeberg.org",
      onSubmit: (host) => {
        if (host === "") return "an instance is required";
        return later(ctx, () =>
          promptScreen(ctx, parent, {
            title: `Register an app on ${host}`,
            label: "client id",
            hint: `1. register an app at ${host}/user/settings/applications with redirect ${redirect}  2. paste client id`,
            onSubmit: (clientId) => {
              if (clientId === "") return "a client id is required";
              return (async () => {
                const saved = await registerOriginApp(f.app, f.user, {
                  host,
                  clientId,
                });
                if (!saved.ok) {
                  ctx.toast(errorText(saved.error), "danger");
                  return;
                }
                const started = await startOAuthConnect(f.app, f.user, {
                  host,
                  redirectUri: redirect,
                });
                if (!started.ok) {
                  ctx.toast(started.error.message, "danger");
                  return;
                }
                ctx.push(
                  authorizeScreen(f, ctx, parent, started.value.url, done),
                );
              })();
            },
          }),
        );
      },
    }),
  );
}

/**
 * Print the authorize URL and wait. The callback lands on the *web* surface,
 * so this screen has nothing to poll but the origin list itself — which is
 * exactly the question being asked: did an origin appear?
 */
function authorizeScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  url: string,
  done: () => void,
): Screen {
  const before = f.user ? listUserOrigins(f.app, f.user).length : 0;
  let finished = false;
  return {
    title: "Authorize",
    keys: [binding(["esc"], "cancel")],
    load(signal) {
      const timer = setInterval(() => {
        if (finished || !f.user) return;
        if (listUserOrigins(f.app, f.user).length <= before) return;
        finished = true;
        clearInterval(timer);
        ctx.toast("origin connected", "success");
        done();
        ctx.pop();
      }, 1000);
      signal.addEventListener("abort", () => clearInterval(timer));
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      parent.render(area, s);
      const w = Math.min(72, Math.max(24, area.w - 6));
      const h = Math.min(area.h, 10);
      const inner = card(
        s,
        {
          x: area.x + ((area.w - w) >> 1),
          y: area.y + ((area.h - h) >> 1),
          w,
          h,
        },
        c,
        { title: "Authorize on the instance", focused: true },
      );
      const right = inner.x + inner.w;
      s.text(
        inner.x,
        inner.y,
        truncate("Open this URL and approve the application:", inner.w),
        style(c.mutedFg, c.card),
        right,
      );
      for (const [i, line] of wrap(url, inner.w).entries()) {
        if (i > 2) break;
        s.text(inner.x, inner.y + 2 + i, line, style(c.accent, c.card), right);
      }
      const x = spinner(s, inner.x, inner.y + 6, c, ctx.tick);
      s.text(
        x + 1,
        inner.y + 6,
        truncate("waiting for you to authorize…", Math.max(0, right - x - 1)),
        style(c.mutedFg, c.card),
        right,
      );
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        finished = true;
        ctx.pop();
      }
      return true;
    },
  };
}

/** Hard-wrap a URL: it has no spaces, so nothing else will break it. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const chars = [...text];
  const size = Math.max(1, width);
  for (let at = 0; at < chars.length; at += size)
    out.push(chars.slice(at, at + size).join(""));
  return out;
}

// ---- the picker ----

/**
 * One origin's repositories. `enter` and `m` both mirror, because the only
 * thing you do to a row here is take it — and the ones already taken say so
 * rather than silently doing nothing.
 */
export function originReposScreen(
  f: Session,
  ctx: Ctx,
  origin: Origin,
): Screen {
  let repos: OriginRepoRow[] = [];
  let failed = false;
  const state = new ListState();
  const filter = new Filter();

  const load = async (refresh = false): Promise<void> => {
    const listed = await listRemoteRepos(f.app, f.user, origin.id, refresh);
    failed = !listed.ok;
    repos = listed.ok ? listed.value : [];
    state.clamp(repos.length);
    ctx.invalidate();
  };

  const shown = (): OriginRepoRow[] =>
    repos.filter((r) => filter.matches(`${r.fullName} ${r.description}`));

  const mirror = (remote: OriginRepoRow): void => {
    if (remote.mirroredAs !== null) {
      ctx.toast("already mirrored", "attn");
      return;
    }
    runAsync(ctx, async () => {
      const made = await mirrorRepo(f.app, f.user, origin.id, remote.fullName);
      if (!made.ok) {
        ctx.toast(errorText(made.error), "danger");
        return;
      }
      await load();
      ctx.toast(`mirrored as ${made.value.name}`, "success");
      ctx.push(repoScreen(f, ctx, made.value));
    });
  };

  return {
    title: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter", "m"], "mirror"),
      binding(["/"], "filter"),
      binding(["r"], "refresh from origin"),
    ],
    load: () => load(),
    render(area, s) {
      const c = ctx.theme.c;
      const [box, body] = split(area, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter repositories"));
      const rows = shown();
      if (rows.length === 0) {
        emptyState(s, body!, c, {
          title: failed ? "The origin could not be reached" : "No repositories",
          body: failed
            ? "Nothing was changed. Press r to try again."
            : "Nothing on this origin matches.",
        });
        return;
      }
      drawList(
        s,
        body!,
        c,
        state,
        rows.map((remote): ListRow => {
          const marks = [
            remote.private ? "private" : "public",
            remote.fork ? "fork" : "",
            remote.mirroredAs !== null ? `${G.check} mirrored` : "",
          ].filter((m) => m !== "");
          return {
            title: remote.fullName,
            secondary: marks.join(" · "),
            meta:
              remote.pushedAt === null
                ? "never pushed"
                : `pushed ${ago(remote.pushedAt)}`,
          };
        }),
      );
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      const rows = shown();
      if (state.key(e, rows.length)) return true;
      if (e.key === "enter" || e.key === "m") {
        const remote = rows[state.index];
        if (remote) mirror(remote);
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, () => load(true));
        return true;
      }
      return false;
    },
  };
}
