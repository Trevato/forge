/**
 * Migrate from the terminal: the web's `/migrate`, one step per screen.
 *
 * Pick a repository from your connected origins (or paste a URL), pick the
 * branch the app lives on, say where it lands and who works on it, then watch
 * the job. Nothing here is a second path: the last step is `migrateRepo`
 * with `branch` and `crew`, and this file only puts its questions and its
 * answer on a terminal.
 *
 * An origin whose token sees public repositories only says so under the
 * rows, with GitHub's new-token page to visit; `t` takes the new token
 * into `replaceOriginToken`, the action the web page posts to.
 */

import { listAllAgents } from "../../actions/crew.ts";
import {
  type AfterMigration,
  migrateMessage,
  migrateRepo,
  type MigrateSource,
} from "../../actions/migrate.ts";
import {
  listRemoteRepos,
  listUserOrigins,
  replaceOriginToken,
} from "../../actions/origins.ts";
import { repositoryLimitMessage } from "../../actions/repos.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import type { OriginRepoRow } from "../../core/origins.ts";
import type { User } from "../../core/users.ts";
import { subscribe, type MirrorJob, type MirrorStage } from "../../origins/jobs.ts";
import { providerForOrigin } from "../../origins/credential.ts";
import { cachedRemoteTips, pickWorkBranch } from "../../origins/work-branch.ts";
import { getOriginFor } from "../../core/origins.ts";
import {
  PUBLIC_ONLY,
  newTokenUrl,
  replaceTokenMessage,
  tokenReach,
} from "../../origins/token-reach.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { G } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, field, spinner } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ago,
  drawList,
  Filter,
  hitList,
  ListState,
  pickerScreen,
  promptScreen,
  runAsync,
} from "./common.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";

interface Row {
  readonly originId: string;
  readonly origin: string;
  readonly repo: OriginRepoRow;
}

/** An origin whose token lists public repositories only. */
interface PublicOnly {
  readonly originId: string;
  readonly login: string;
  readonly webUrl: string;
}

/** Where the repository comes from, and — for an origin — the branch chosen. */
interface Picked {
  readonly source: MigrateSource;
  readonly label: string;
  readonly name: string;
  readonly branch?: string;
}

const STAGES: readonly { stage: MirrorStage; label: string }[] = [
  { stage: "creating", label: "Creating the repository" },
  { stage: "fetching", label: "Cloning every branch and tag" },
  { stage: "crew", label: "Putting the crew on it" },
];

/** Step one: the repositories of every connected origin, or a pasted URL. */
export function migrateScreen(f: Session, ctx: Ctx): Screen {
  const user = f.user;
  const state = new ListState();
  const filter = new Filter();
  let rows: Row[] = [];
  let loading = true;
  // Origins that would not answer: said aloud, never read as "no repositories".
  let unreachable: string[] = [];
  let publicOnly: PublicOnly[] = [];
  let self: Screen;

  const shown = (): Row[] =>
    rows.filter((r) => filter.matches(r.repo.fullName));

  const toForm = (picked: Picked): void => {
    if (user !== undefined) ctx.push(migrateFormScreen(f, ctx, user, picked));
  };

  const choose = (row: Row): void => {
    if (user === undefined) return;
    runAsync(ctx, async () => {
      const origin = getOriginFor(f.db, user.id, row.originId);
      const provider =
        origin === undefined ? undefined : providerForOrigin(f.app, origin);
      const tips =
        origin === undefined || provider === undefined || !provider.ok
          ? undefined
          : await cachedRemoteTips(origin.id, provider.value, row.repo.fullName, {
              logins: [origin.login, user.username],
              emails: [user.email],
            });
      if (tips === undefined || tips.length === 0) {
        ctx.toast(
          tips === undefined
            ? "Could not reach the origin. Try again."
            : `${row.repo.fullName} has no branches`,
          "danger",
        );
        return;
      }
      const suggested = pickWorkBranch(tips, row.repo.defaultBranch);
      // Newest first, the suggestion on top, so Enter takes it.
      const ordered = [...tips]
        .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
        .sort(
          (a, b) => Number(b.name === suggested) - Number(a.name === suggested),
        );
      ctx.push(
        pickerScreen(ctx, self, {
          title: `Branch of ${row.repo.fullName}`,
          items: ordered.map((tip) => ({
            id: tip.name,
            label: tip.name === suggested ? `${tip.name} (suggested)` : tip.name,
            hint: [
              tip.subject,
              tip.author,
              tip.date === "" ? "" : ago(tip.date),
            ]
              .filter((p) => p !== "")
              .join(" · "),
          })),
          onPick: ([branch]) => {
            if (branch === undefined) return;
            toForm({
              source: { originId: row.originId, fullName: row.repo.fullName },
              label: row.repo.fullName,
              name: row.repo.fullName.split("/").pop() ?? "",
              branch,
            });
          },
        }),
      );
    });
  };

  const pasteUrl = (): void => {
    ctx.push(
      promptScreen(ctx, self, {
        title: "Migrate from a URL",
        label: "Repository URL",
        placeholder: "https://github.com/owner/name",
        hint: "Public, over https. Cloned anonymously.",
        onSubmit: (url) => {
          if (url === "") return "Paste an address first.";
          const name =
            (url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "")
              .replace(/\.git$/i, "");
          return Promise.resolve().then(() =>
            toForm({ source: { url }, label: url, name }),
          );
        },
      }),
    );
  };

  const replaceToken = (origin: PublicOnly): void => {
    if (user === undefined) return;
    ctx.push(
      promptScreen(ctx, self, {
        title: `Replace the token for ${origin.login}`,
        label: "New token (with repo)",
        hint: newTokenUrl(origin.webUrl),
        mask: true,
        onSubmit: (token) => {
          if (token.trim() === "") return "Paste the new token first.";
          return replaceOriginToken(f.app, user, origin.originId, token).then(
            async (replaced) => {
              if (!replaced.ok) {
                ctx.toast(replaceTokenMessage(replaced.error), "danger");
                return;
              }
              ctx.toast(`Token replaced for ${origin.login}; listed again.`);
              await self.load?.(new AbortController().signal);
              ctx.invalidate();
            },
          );
        },
      }),
    );
  };

  const pickReplace = (): void => {
    if (publicOnly.length === 1) return replaceToken(publicOnly[0]!);
    ctx.push(
      pickerScreen(ctx, self, {
        title: "Replace which token",
        items: publicOnly.map((o) => ({ id: o.originId, label: o.login })),
        onPick: ([id]) => {
          const origin = publicOnly.find((o) => o.originId === id);
          if (origin !== undefined) replaceToken(origin);
        },
      }),
    );
  };

  self = {
    title: "Migrate a repository",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "pick branch"),
        binding(["/"], "filter"),
        binding(["u"], "paste a URL"),
        ...(publicOnly.length > 0 ? [binding(["t"], "replace token")] : []),
        binding(["esc"], "back"),
      ];
    },
    async load() {
      if (user === undefined) {
        loading = false;
        return;
      }
      const out: Row[] = [];
      const failed: string[] = [];
      const limited: PublicOnly[] = [];
      for (const origin of listUserOrigins(f.app, user)) {
        const [listed, reach] = await Promise.all([
          listRemoteRepos(f.app, user, origin.id),
          tokenReach(f.app, origin),
        ]);
        if (reach === "public")
          limited.push({
            originId: origin.id,
            login: origin.login,
            webUrl: origin.webUrl,
          });
        if (!listed.ok) {
          failed.push(origin.login);
          continue;
        }
        for (const repo of listed.value)
          out.push({ originId: origin.id, origin: origin.login, repo });
      }
      rows = out;
      unreachable = failed;
      publicOnly = limited;
      loading = false;
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [top, list, foot] = split(area, "v", [
        len(2),
        fill(1),
        len(publicOnly.length === 0 ? 0 : 2 * publicOnly.length),
      ]);
      publicOnly.forEach((o, i) => {
        const at = foot!.y + 2 * i;
        s.text(
          foot!.x,
          at,
          truncate(`${PUBLIC_ONLY} — ${o.login}.`, foot!.w),
          style(c.attn, c.bg),
          foot!.x + foot!.w,
        );
        s.text(
          foot!.x,
          at + 1,
          truncate(`Make one with repo at ${newTokenUrl(o.webUrl)} · t to paste it`, foot!.w),
          style(c.mutedFg, c.bg),
          foot!.x + foot!.w,
        );
      });
      ctx.setCursor(filter.render(s, { ...top!, h: 1 }, c, "filter repositories"));
      const items = shown();
      const down = `Could not reach ${unreachable.join(", ")}.`;
      if (unreachable.length > 0 && items.length > 0)
        s.text(
          top!.x,
          top!.y + 1,
          truncate(`${down} The others are listed.`, top!.w),
          style(c.danger, c.bg),
          top!.x + top!.w,
        );
      if (items.length === 0) {
        s.text(
          list!.x,
          list!.y,
          truncate(
            loading
              ? "loading your origins…"
              : rows.length === 0 && unreachable.length > 0
                ? `${down} Try again, or press u to paste a URL.`
                : rows.length === 0
                  ? "No connected origin has repositories. Press u to paste a URL, or connect one on the web under Settings → Origins."
                  : "Nothing matches.",
            list!.w,
          ),
          style(c.mutedFg, c.bg),
          list!.x + list!.w,
        );
        return;
      }
      drawList(
        s,
        list!,
        c,
        state,
        items.map((r) => ({
          title: r.repo.fullName,
          secondary: r.repo.private ? "private" : "",
          meta: [
            r.origin,
            r.repo.pushedAt === null ? "" : `pushed ${ago(r.repo.pushedAt)}`,
          ]
            .filter((p) => p !== "")
            .join(" · "),
        })),
      );
      hitList(ctx, list!, state, items.length, {
        open: (i) => {
          const row = items[i];
          if (row !== undefined) choose(row);
        },
      });
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.key === "u") {
        pasteUrl();
        return true;
      }
      if (e.key === "t" && publicOnly.length > 0) {
        pickReplace();
        return true;
      }
      if (state.key(e, shown().length)) return true;
      if (e.key === "enter") {
        const row = shown()[state.index];
        if (row !== undefined) choose(row);
        return true;
      }
      return true;
    },
  };
  return self;
}

type Focus = 0 | 1 | 2 | 3 | 4 | 5;

/** What becomes of the source afterwards: the web form's three choices. */
const AFTER: readonly { id: AfterMigration; text: string }[] = [
  { id: "leave", text: "leave it alone" },
  { id: "archive", text: "archive it on the origin" },
  { id: "mirror", text: "keep it as a read-only mirror the forge pushes to" },
];

/** Step three: where it lands, and who works on it. */
function migrateFormScreen(
  f: Session,
  ctx: Ctx,
  user: User,
  picked: Picked,
): Screen {
  const writeOrgs = listOrgsForUser(f.db, user.id).filter((org) =>
    accessAllows(orgAccess(f.db, org.id, user), "write"),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];
  const agents = listAllAgents(f.app, user);
  // "" is nobody: just the repository.
  const crew = ["", ...(agents.ok ? agents.value.map((a) => a.user.username) : [])];
  let name = picked.name;
  let ownerIndex = 0;
  let visibility: "public" | "private" = "private";
  let agentIndex = 0;
  let autonomous = false;
  let afterIndex = 0;
  let focus: Focus = 0;
  let error: string | undefined;
  let busy = false;

  const submit = (): void => {
    if (busy) return;
    busy = true;
    runAsync(ctx, async () => {
      try {
        const agent = crew[agentIndex] ?? "";
        const started = await migrateRepo(f.app, user, {
          source: picked.source,
          owner: owners[ownerIndex] ?? user.username,
          name,
          visibility,
          after: AFTER[afterIndex]?.id ?? "leave",
          ...(picked.branch === undefined ? {} : { branch: picked.branch }),
          ...(agent === "" ? {} : { crew: { agent, autonomous } }),
        });
        if (!started.ok) {
          error = migrateMessage(
            started.error,
            repositoryLimitMessage(f.app, user),
          );
          ctx.toast(error, "danger");
          ctx.invalidate();
          return;
        }
        ctx.replace(jobScreen(f, ctx, started.value.job, picked.label));
      } finally {
        busy = false;
      }
    });
  };

  const cycle = (): void => {
    if (focus === 1) ownerIndex = (ownerIndex + 1) % owners.length;
    if (focus === 2) visibility = visibility === "private" ? "public" : "private";
    if (focus === 3) agentIndex = (agentIndex + 1) % crew.length;
    if (focus === 4) autonomous = !autonomous;
    if (focus === 5) afterIndex = (afterIndex + 1) % AFTER.length;
  };

  return {
    title: "Migrate",
    keys: [
      binding(["tab"], "next field"),
      binding(["space"], "change"),
      binding(["ctrl+d"], "migrate"),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [top, rest] = split(area, "v", [len(5), fill(1)]);
      const right = area.x + area.w;
      s.text(
        area.x,
        area.y,
        truncate(
          `from ${picked.label}${picked.branch === undefined ? "" : ` · branch ${picked.branch}`}`,
          area.w,
        ),
        style(c.mutedFg, c.bg),
        right,
      );
      const cursor = field(s, { x: top!.x, y: top!.y + 1, w: top!.w, h: 3 }, c, {
        label: `Name (under ${owners[ownerIndex] ?? "?"})`,
        value: name,
        focused: focus === 0,
        ...(focus === 0 ? { cursor: [...name].length } : {}),
        ...(error === undefined
          ? { hint: "Blank keeps the source's name." }
          : { error }),
      });
      ctx.setCursor(focus === 0 ? cursor : null);
      const lines = [
        `owner       ${owners[ownerIndex] ?? "?"}`,
        `visibility  ${visibility}`,
        `agent       ${crew[agentIndex] === "" ? "nobody — just the repository" : crew[agentIndex]}`,
        `autonomy    ${autonomous ? "autonomous — green ships on its own" : "every green change waits for your look"}`,
        `afterwards  ${AFTER[afterIndex]?.text ?? ""}`,
      ];
      lines.forEach((line, i) =>
        s.text(
          rest!.x,
          rest!.y + i,
          truncate(line, rest!.w),
          style(focus === i + 1 ? c.accent : c.mutedFg, c.bg),
          rest!.x + rest!.w,
        ),
      );
    },
    paste(text) {
      if (focus === 0) name += text.replace(/\s+/g, "");
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.ctrl && e.key === "d") {
        submit();
        return true;
      }
      if (e.key === "tab") {
        focus = ((focus + 1) % 6) as Focus;
        return true;
      }
      if (focus > 0 && (e.key === " " || e.key === "enter")) {
        cycle();
        return true;
      }
      if (e.key === "enter") {
        submit();
        return true;
      }
      if (focus === 0 && e.key === "backspace") {
        name = [...name].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (focus === 0 && !e.ctrl && !e.alt && [...e.key].length === 1) {
        name += e.key;
        error = undefined;
      }
      return true;
    },
  };
}

/**
 * Step four: watching the job, as `mirror.ts` watches a mirror. Esc hides the
 * card and never cancels; the watcher toasts when it lands either way, and
 * the card itself replaces itself with the repository when it finishes.
 */
function jobScreen(
  f: Session,
  ctx: Ctx,
  started: MirrorJob,
  label: string,
): Screen {
  let job = started;
  // Not tied to this card: hiding it must not silence the outcome. It ends
  // itself at done or failed, which every job reaches.
  const watching = subscribe(job.id, (current) => {
    if (current.stage === "done") {
      watching();
      ctx.toast(current.detail === "" ? "migrated" : current.detail, "success");
    } else if (current.stage === "failed") {
      watching();
      ctx.toast(current.error ?? "the migration failed", "danger");
    }
  });

  return {
    title: `Migrating ${label}`,
    keys: [binding(["esc"], "hide — it keeps running")],
    load(signal) {
      const off = subscribe(job.id, (current) => {
        job = current;
        ctx.invalidate();
        if (current.stage === "done" && current.repo !== undefined)
          ctx.replace(repoScreen(f, ctx, local(f, current.repo)));
      });
      const timer = setInterval(() => ctx.invalidate(), 120);
      signal.addEventListener("abort", () => {
        off();
        clearInterval(timer);
      });
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const w = Math.min(64, Math.max(24, area.w - 6));
      const h = Math.min(area.h, STAGES.length + 4);
      const inner = card(
        s,
        {
          x: area.x + ((area.w - w) >> 1),
          y: area.y + ((area.h - h) >> 1),
          w,
          h,
        },
        c,
        {
          title: `Migrating ${label}`,
          footer: "esc hides this",
          focused: true,
          ...(job.stage === "failed" ? { tone: "danger" as const } : {}),
        },
      );
      const right = inner.x + inner.w;
      const at = STAGES.findIndex((x) => x.stage === job.stage);
      const finished = job.stage === "done";
      STAGES.forEach(({ label: text }, i) => {
        const y = inner.y + i;
        const past = finished || (at >= 0 && i < at);
        const now = at === i;
        let x = inner.x;
        if (now) x = spinner(s, x, y, c, ctx.tick);
        else
          x = s.text(
            x,
            y,
            past ? G.check : G.ring,
            style(past ? c.success : c.faint, c.card),
            right,
          );
        x = s.text(
          x + 1,
          y,
          truncate(text, Math.max(0, right - x - 1)),
          style(now ? c.fg : past ? c.mutedFg : c.faint, c.card),
          right,
        );
        if (now && job.detail !== "")
          s.text(
            x + 2,
            y,
            truncate(job.detail, Math.max(0, right - x - 2)),
            style(c.mutedFg, c.card),
            right,
          );
      });
      const y = inner.y + STAGES.length;
      if (job.stage === "failed")
        s.text(
          inner.x,
          y,
          truncate(`${G.cross} ${job.error ?? "the migration failed"}`, inner.w),
          style(c.danger, c.card),
          right,
        );
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        ctx.toast("migrating in the background", "default");
      }
      return true;
    },
  };
}
