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
  pollOAuthConnect,
  registerOriginApp,
  startOAuthConnect,
  syncOriginNow,
} from "../../actions/origins.ts";
import type { OriginRepoRow } from "../../core/origins.ts";
import { isPinned } from "../../core/pins.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
import { sourceFor } from "../../view/source.ts";
import type { Origin } from "../../origins/types.ts";
import { forgeBaseUrl, oauthCallbackUri } from "../../http/api.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import { BOLD, style, type Style } from "../term/style.ts";
import { G, type Rect, type Screen as TermScreen } from "../term/screen.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState, spinner } from "../ui/widgets.ts";
import { drawQr, qrSize, terminalQr } from "../ui/qr.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  PIN_MARK,
  ago,
  confirmScreen,
  drawList,
  errorText,
  promptScreen,
  runAsync,
  type ListRow,
} from "./common.ts";
import { startMirror } from "./mirror.ts";
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

/**
 * Where an OAuth application must send the browser back to.
 *
 * The same rule the web surface uses, asked from this side: `FORGE_URL`, or a
 * host the operator vouched for, or loopback. A terminal session has no
 * request to read a Host header from — which is the point, since that header
 * was never trustworthy for this — so it asks about the forge's own address.
 */
function callbackUri(f: Session): string {
  const url = selfUrl(f);
  return url === null ? "" : oauthCallbackUri(url, f.app.config.host);
}

/** The forge's own base URL, by the same rule — "" when it knows of none. */
function baseUri(f: Session): string {
  const url = selfUrl(f);
  return url === null ? "" : forgeBaseUrl(url, f.app.config.host);
}

function selfUrl(f: Session): URL | null {
  const host = f.app.config.host ?? "localhost";
  return URL.parse(`http://${host}:${f.app.config.port ?? 3000}/`);
}

/** `<forge>/go/<code>` — what a phone types, or a camera reads. */
function shortLink(f: Session, code: string): string {
  const base = baseUri(f);
  return base === "" || code === "" ? "" : `${base}/go/${code}`;
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
      binding(["c"], "connect — a token needs no setup"),
      binding(["s"], "sync now"),
      binding(["r"], "browse its repositories"),
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
          body: "Paste a personal access token — or set up one-click GitHub or Forgejo.",
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
 * preference, so the rows say what each one *is* rather than offering them
 * as equals — and they are in the order that gets a person connected.
 *
 * The token is first because it is the only route with no setup at all: you
 * paste a string and you are connected, on any forge, from any terminal. The
 * two one-click flows are genuinely nicer *once they exist*, and each needs
 * somebody to register an application first — so each says so on its own
 * line rather than failing later with an error about an environment
 * variable.
 */
function connectScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  done: () => void,
): Screen {
  const ways = [
    {
      id: "token",
      label: "Personal access token — recommended",
      note: "No setup at all. Works with any forge, any terminal.",
      note2: "Paste one from the forge and you are connected.",
    },
    {
      id: "github",
      label: "GitHub, one click",
      note: "Needs a one-time OAuth app setup.",
      note2: "Then a short code you type on your phone.",
    },
    {
      id: "forgejo",
      label: "Forgejo / Gitea, one click",
      note: "Needs an app registration on the instance.",
      note2: "Then a browser to authorize it.",
    },
  ] as const;
  let at = 0;

  return {
    title: "Connect an origin",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "choose"),
      binding(["esc"], "cancel"),
    ],
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      const w = Math.min(62, Math.max(24, area.w - 4));
      const h = Math.min(area.h, ways.length * 4 + 1);
      const inner = card(
        s,
        {
          x: area.x + ((area.w - w) >> 1),
          y: area.y + ((area.h - h) >> 1),
          w,
          h,
        },
        c,
        { title: "Connect an origin", focused: true },
      );
      const right = inner.x + inner.w;
      ways.forEach((way, i) => {
        const y = inner.y + i * 4;
        if (y + 2 >= inner.y + inner.h) return;
        const chosen = i === at;
        s.text(
          inner.x,
          y,
          chosen ? G.caretRight : " ",
          style(c.accent, c.card),
          right,
        );
        s.text(
          inner.x + 2,
          y,
          truncate(way.label, Math.max(0, inner.w - 2)),
          style(chosen ? c.fg : c.mutedFg, c.card, chosen ? BOLD : 0),
          right,
        );
        for (const [n, line] of [way.note, way.note2].entries())
          s.text(
            inner.x + 2,
            y + 1 + n,
            truncate(line, Math.max(0, inner.w - 2)),
            style(c.faint, c.card),
            right,
          );
      });
    },
    key(e) {
      if (e.key === "j" || e.key === "down") at = (at + 1) % ways.length;
      else if (e.key === "k" || e.key === "up")
        at = (at - 1 + ways.length) % ways.length;
      else if (e.key === "enter") {
        const choice = ways[at]?.id;
        ctx.pop();
        if (choice === "github") askGithubHost(f, ctx, parent, done);
        else if (choice === "forgejo") startCodeFlow(f, ctx, parent, done);
        else if (choice === "token") startToken(f, ctx, parent, done);
      } else if (e.key === "esc" || e.key === "q") ctx.pop();
      return true;
    },
  };
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
      // "Not configured" is a task, not a status: the one error a person can
      // actually fix from here gets the instructions instead of a toast that
      // names an environment variable and leaves them to it.
      if (started.error.error === "no_app")
        ctx.push(githubSetup(f, ctx, parent));
      else ctx.toast(started.error.message, "danger");
      return;
    }
    ctx.push(deviceScreen(f, ctx, parent, started.value, done));
  });
}

// ---- handing a connect to a device that has a browser ----

/**
 * Everything a person needs to finish a connect somewhere else, and every way
 * of getting it to them.
 *
 * This screen exists because of one situation: the forge is on a server, you
 * are in a terminal over SSH, and the URL on the screen is a string you can
 * neither click nor reliably copy. So all three routes off this screen are
 * offered at once — a QR code the phone in your hand reads directly, a short
 * link that is ten characters of path and can be typed by hand, and OSC 52,
 * which asks *your* terminal (not the server) to put the link on *your*
 * clipboard. Opening a browser is the one thing that genuinely cannot be done
 * from the far side of an SSH connection, and `o` says so rather than
 * appearing to work.
 */
interface Handoff {
  /** The device grant's user code. Empty for the code flow, which has none. */
  readonly userCode: string;
  /** The full URL the person has to reach. */
  readonly url: string;
  /** `<forge>/go/<code>`, or "" when the forge does not know its address. */
  readonly link: string;
  /** The lead line: what to do with all this. */
  readonly lead: string;
  /** What the spinner says. A failed poll rewrites it. */
  detail: string;
}

function handoffKeys(h: Handoff): Binding[] {
  return [
    binding(["c"], "copy link"),
    ...(h.userCode === "" ? [] : [binding(["C"], "copy code")]),
    binding(["o"], "open"),
    binding(["esc"], "cancel"),
  ];
}

const COPY_NOTE =
  "copied — if your terminal allows it (iTerm2, Ghostty, kitty, WezTerm do; Apple Terminal does not)";

function handoffKey(ctx: Ctx, h: Handoff, key: string): boolean {
  if (key === "c") {
    ctx.copy(h.link === "" ? h.url : h.link);
    ctx.toast(COPY_NOTE, "success");
    return true;
  }
  if (key === "C" && h.userCode !== "") {
    ctx.copy(h.userCode);
    ctx.toast(COPY_NOTE, "success");
    return true;
  }
  if (key === "o") {
    if (ctx.openUrl(h.url)) ctx.toast("opening in your browser", "success");
    else
      ctx.toast(
        "no browser on this machine — scan the code, or open the short link",
        "attn",
      );
    return true;
  }
  return false;
}

/**
 * Draw the card. The QR is the first thing dropped when the terminal is
 * short: a code that does not fit is not a smaller code, and the short link
 * below it says the same thing in characters.
 */
function drawHandoff(
  ctx: Ctx,
  surface: TermScreen,
  area: Rect,
  parent: Screen,
  h: Handoff,
  title: string,
): void {
  const c = ctx.theme.c;
  parent.render(area, surface);
  const w = Math.min(64, Math.max(24, area.w - 6));
  const urlLines = wrap(h.url, w).slice(0, 2);
  const linkRows = h.link === "" ? 0 : 1;
  const codeRows = h.userCode === "" ? 0 : 2;
  const fixed = 1 + codeRows + 1 + linkRows + urlLines.length + 1 + 1;

  const qr = terminalQr(h.link === "" ? h.url : h.link);
  const dim = qr === undefined ? undefined : qrSize(qr);
  const withQr =
    qr !== undefined &&
    dim !== undefined &&
    dim.cols <= w &&
    fixed + dim.rows + 1 + 2 <= area.h;
  const rows = fixed + (withQr && dim ? dim.rows + 1 : 0);
  const height = Math.min(area.h, rows + 2);

  const inner = card(
    surface,
    {
      x: area.x + ((area.w - w) >> 1),
      y: area.y + ((area.h - height) >> 1),
      w,
      h: height,
    },
    c,
    { title, focused: true },
  );
  const right = inner.x + inner.w;
  let y = inner.y;
  const line = (text: string, st: Style, centred = false): void => {
    const x = centred
      ? inner.x + Math.max(0, (inner.w - text.length) >> 1)
      : inner.x;
    surface.text(x, y++, truncate(text, inner.w), st, right);
  };

  line(h.lead, style(c.mutedFg, c.card));
  if (h.userCode !== "") {
    y++;
    // The code is the whole point of the screen, so it gets the one
    // deliberately loud line in the terminal UI: spaced out, centred.
    line([...h.userCode].join(" "), style(c.fg, c.card, BOLD), true);
  }
  y++;
  if (withQr && qr) {
    y = drawQr(surface, { x: inner.x, y, w: inner.w, h: inner.h }, qr);
    y++;
  }
  if (h.link !== "") line(h.link, style(c.accent, c.card));
  for (const part of urlLines) line(part, style(c.faint, c.card));
  y++;
  const x = spinner(surface, inner.x, y, c, ctx.tick);
  surface.text(
    x + 1,
    y,
    truncate(h.detail, Math.max(0, right - x - 1)),
    style(c.mutedFg, c.card),
    right,
  );
}

/**
 * How to make the GitHub button work, in the three steps that do it. Shown
 * where the failure happens, because a person who just pressed "GitHub" is
 * exactly the person who wants to know.
 */
function githubSetup(f: Session, ctx: Ctx, parent: Screen): Screen {
  const back = callbackUri(f);
  return confirmScreen(ctx, parent, {
    title: "Set up GitHub",
    body: [
      "No GitHub OAuth application is configured yet.",
      "",
      "1. Create an OAuth App at",
      "   github.com/settings/developers. Homepage: this",
      "   forge. Authorization callback URL:",
      `   ${back === "" ? "<your forge>/settings/origins/callback" : back}`,
      "   Tick 'Enable Device Flow'.",
      "2. Start the forge with",
      "   FORGE_GITHUB_CLIENT_ID=<client id>  (and, only",
      "   for revoke-on-disconnect, the client secret).",
      "3. Come back here — GitHub connects.",
      "",
      "Until then, a pasted token needs no setup at all.",
    ],
    actions: [{ label: "OK", variant: "default" }],
    onChoose: () => undefined,
  });
}

/**
 * The device-code screen: the code, the ways to reach the verification page,
 * and a spinner while the forge polls on the user's behalf. Esc cancels — the
 * flow row expires on its own, so abandoning it costs nothing.
 */
function deviceScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  flow: {
    flowId: string;
    userCode: string;
    url: string;
    shortCode: string;
    intervalSecs: number;
  },
  done: () => void,
): Screen {
  let finished = false;
  const handoff: Handoff = {
    userCode: flow.userCode,
    url: flow.url,
    link: shortLink(f, flow.shortCode),
    lead: `Type this code at ${hostLabel(flow.url)}:`,
    detail: "waiting for you to authorize…",
  };

  return {
    title: "Connect GitHub",
    keys: handoffKeys(handoff),
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
          handoff.detail = polled.value.detail || "that connect failed";
          ctx.toast(handoff.detail, "danger");
          ctx.invalidate();
        })();
      }, every);
      signal.addEventListener("abort", () => clearInterval(timer));
      return Promise.resolve();
    },
    render(area, s) {
      drawHandoff(ctx, s, area, parent, handoff, "Connect GitHub");
    },
    key(e) {
      if (handoffKey(ctx, handoff, e.key)) return true;
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
        if (redirect === "")
          return "this forge does not know its own public URL — set FORGE_URL";
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
                  authorizeScreen(
                    f,
                    ctx,
                    parent,
                    {
                      url: started.value.url,
                      shortCode: started.value.shortCode,
                    },
                    done,
                  ),
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
 *
 * A Forgejo authorize URL is long — client id, state, challenge, scopes —
 * which is precisely the URL nobody retypes off a terminal. The short link
 * and the QR carry it instead.
 */
function authorizeScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  flow: { url: string; shortCode: string },
  done: () => void,
): Screen {
  const before = f.user ? listUserOrigins(f.app, f.user).length : 0;
  let finished = false;
  const handoff: Handoff = {
    userCode: "",
    url: flow.url,
    link: shortLink(f, flow.shortCode),
    lead: `Open this and approve the application on ${hostLabel(flow.url)}:`,
    detail: "waiting for you to authorize…",
  };
  return {
    title: "Authorize",
    keys: handoffKeys(handoff),
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
      drawHandoff(ctx, s, area, parent, handoff, "Authorize on the instance");
    },
    key(e) {
      if (handoffKey(ctx, handoff, e.key)) return true;
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
 * One origin's repositories.
 *
 * `enter` *opens* the repository — live, read-only, through the origin's own
 * API — and nothing is downloaded. This is the whole point of the picker:
 * pressing enter used to mean "clone this, import every issue, and take
 * several seconds doing it with nothing on screen", which taught people to
 * press it twice. Taking a copy is now a separate, deliberate key with a
 * progress card behind it, and a row that has already been taken says so.
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

  /** The local repository a row was mirrored into, if it still exists. */
  const mirrorOf = (remote: OriginRepoRow): Repo | undefined =>
    remote.mirroredAs === null
      ? undefined
      : getRepoById(f.db, remote.mirroredAs);

  const browse = (remote: OriginRepoRow): void => {
    const src = sourceFor(f.app, f.user, {
      originId: origin.id,
      fullName: remote.fullName,
    });
    if (!src.ok) {
      ctx.toast(errorText(src.error), "danger");
      return;
    }
    // Pushed with nothing loaded: the screen paints its own frame with a
    // spinner and fills in as the origin answers.
    ctx.push(repoScreen(f, ctx, src.value));
  };

  const screen: Screen = {
    title: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "browse — nothing is downloaded"),
      binding(["m"], "mirror into your workbench"),
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
          const held = mirrorOf(remote);
          const pinned =
            held !== undefined &&
            f.user !== undefined &&
            isPinned(f.db, f.user.id, held.id);
          const marks = [
            remote.private ? "private" : "public",
            remote.fork ? "fork" : "",
            held === undefined
              ? ""
              : `${G.dot} mirrored as ${held.ownerName}/${held.name}`,
            pinned ? `${PIN_MARK} on your machine` : "",
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
      if (e.key === "enter") {
        const remote = rows[state.index];
        if (remote) browse(remote);
        return true;
      }
      if (e.key === "m") {
        const remote = rows[state.index];
        if (remote === undefined) return true;
        if (remote.mirroredAs !== null) {
          ctx.toast("already mirrored — enter opens it", "attn");
          return true;
        }
        startMirror(f, ctx, {
          parent: screen,
          originId: origin.id,
          fullName: remote.fullName,
          onLanded: () => {
            runAsync(ctx, () => load());
          },
        });
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, () => load(true));
        return true;
      }
      return false;
    },
  };
  return screen;
}
