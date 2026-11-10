/**
 * A repository's waves: the same rows, in the same order, as the web page,
 * read through `story/waves.ts`. Local repositories only — a live browse of
 * another forge has no `waves/` we can read here, and says so. Enter on a row
 * opens that wave as plain text.
 */

import { cutWaveFor, planCutFor } from "../../actions/cut_wave.ts";
import { canRead, getRepo } from "../../core/repos.ts";
import { VERSION } from "../../story/wave.ts";
import { movedForViewer, type MovedMilestone } from "../../story/wave_moved.ts";
import { milestonePath, planNow } from "../../story/wave_plan.ts";
import { repoBase } from "../../web/chrome.ts";
import { carriedPulls, pullPath, type CarriedPull } from "../../story/wave_pulls.ts";
import { pullRefs, readWave, readWaves, type WaveEntry } from "../../story/waves.ts";
import { NO_WAVES } from "../../story/words.ts";
import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { ListState, Scroll, confirmScreen, drawList, drawLines, hitList, plural, runAsync, yesNo } from "./common.ts";
import { pullScreen } from "./pull.ts";
import { local, localRepo, sourceName, whereRows, whereStrip } from "./where.ts";

/** One line per wave, as the screen draws it. */
export function waveRows(entries: WaveEntry[]) {
  return entries.map((e) =>
    e.ok
      ? {
          title: `${e.wave.version} · ${e.wave.date} · ${e.wave.headline}`,
          secondary: "",
          meta: "",
        }
      : { title: e.file, secondary: `Not a wave: ${e.reason}`, meta: "" },
  );
}

/** Wave text is someone's prose: no escape, control or newline survives into the terminal. */
const plain = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ");

/** A moved milestone with the path that opens it. */
export type MovedLine = MovedMilestone & { path: string };

/** One wave as lines of plain text: headline, version and date, highlights with why, then the pulls the viewer may see. */
export function waveLines(
  entry: WaveEntry,
  pulls: CarriedPull[],
  moved: MovedLine[] = [],
  /** Which pull the cursor is on, marked with `>`; none when null. */
  picked: number | null = null,
): string[] {
  if (!entry.ok) return [plain(entry.file), "", `Not a wave: ${plain(entry.reason)}`];
  const w = entry.wave;
  return [
    plain(w.headline),
    `${plain(w.version)}  ${plain(w.date)}`,
    "",
    "Highlights",
    ...w.highlights.map((h) => `  ${plain(h.title)} - ${plain(h.why)}`),
    "",
    ...(moved.length === 0
      ? []
      : [
          "Moved",
          ...moved.flatMap((m) => [
            `  ${plain(m.title)} - ${m.done} of ${m.total} done`,
            `    ${plain(m.path)}`,
          ]),
          "",
        ]),
    "Pulls",
    ...(pulls.length === 0
      ? ["  No pulls to show here."]
      : pulls.flatMap((p, i) => [
          `${picked === i ? "> " : "  "}#${p.number} ${plain(p.title)}  ${p.mergedAt === null ? p.state : `merged ${p.mergedAt.slice(0, 10)}`}`,
          `    ${plain(pullPath(p))}`,
        ])),
  ];
}

function waveScreen(
  f: Session,
  ctx: Ctx,
  entry: WaveEntry,
  pulls: CarriedPull[],
  moved: MovedLine[],
  src: RepoSource,
): Screen {
  const scroll = new Scroll();
  let picked = 0;
  /** Where the wave's pulls start in the text, so the pick is scrolled into view. */
  const linesFor = (): string[] => waveLines(entry, pulls, moved, pulls.length === 0 ? null : picked);
  const open = (): void => {
    const p = pulls[picked];
    if (p === undefined) return;
    const here = localRepo(src);
    // The pull's own repository, read again through the gate: a wave may name pulls of other repositories.
    const repo =
      here !== undefined && here.ownerName === p.owner && here.name === p.name
        ? here
        : getRepo(f.db, p.owner, p.name);
    if (repo === undefined || !canRead(f.db, repo, f.user)) return;
    // Esc on the pull pops back to this screen: the wave is where the walk began.
    ctx.push(pullScreen(f, ctx, local(f, repo), p.number));
  };
  return {
    title: entry.ok ? entry.wave.version : entry.file,
    keys: [
      binding(["j", "k"], "scroll"),
      ...(pulls.length > 0 ? [binding(["n", "p"], "pick a pull"), binding(["enter"], "open pull")] : []),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = linesFor();
      drawLines(
        s,
        area,
        c,
        scroll,
        lines.map((text) => [{ text, style: style(c.fg, c.bg) }]),
      );
    },
    key(e) {
      if (pulls.length > 0 && !e.ctrl && !e.alt) {
        if (e.key === "n" || e.key === "tab") {
          picked = (picked + 1) % pulls.length;
          ctx.invalidate();
          return true;
        }
        if (e.key === "p") {
          picked = (picked + pulls.length - 1) % pulls.length;
          ctx.invalidate();
          return true;
        }
        if (e.key === "enter") {
          open();
          return true;
        }
      }
      return scroll.key(e, linesFor().length);
    },
  };
}

export function wavesScreen(f: Session, ctx: Ctx, src: RepoSource): Screen {
  const repo = localRepo(src);
  let entries: WaveEntry[] = [];
  let loaded = false;
  const state = new ListState();

  const openAt = (i: number): void => {
    const entry = entries[i];
    if (entry === undefined || repo === undefined) return;
    runAsync(ctx, async () => {
      // Same gate as the list, re-checked: the screen outlives a change of access.
      if (!canRead(f.db, repo, f.user)) return;
      const version = entry.file.slice(0, -3);
      const one = VERSION.test(version)
        ? await readWave(f.dir(repo), repo.defaultBranch, version)
        : entry;
      if (!one) return;
      // The page's gate on each pull: one the viewer cannot read is not named.
      const pulls = one.ok ? carriedPulls(f.db, pullRefs(one.wave), f.user) : [];
      // Same list as the page, from the same function, with the same gate.
      const moved = one.ok
        ? movedForViewer({
            db: f.db,
            repo,
            refs: pullRefs(one.wave),
            viewer: f.user,
            plan: () => planNow(f.db, repo, new Date()),
          }).map((m) => ({ ...m, path: milestonePath(repoBase(repo), m.number) }))
        : [];
      ctx.push(waveScreen(f, ctx, one, pulls, moved, src));
    });
  };

  const reload = async (): Promise<void> => {
    // The web's gate, not a weaker one: whoever reaches this screen, a
    // repository they cannot read has no waves to show.
    entries =
      repo !== undefined && canRead(f.db, repo, f.user)
        ? await readWaves(f.dir(repo), repo.defaultBranch)
        : [];
    loaded = true;
    ctx.invalidate();
  };

  const cut = (): void => {
    if (repo === undefined) return;
    runAsync(ctx, async () => {
      const plan = await planCutFor(f.app, f.user, repo);
      if (!plan.ok) return void ctx.toast(plan.error, "danger");
      const { version, pulls } = plan.value;
      const choose = (choice: number): void => {
              if (choice !== 0) return;
              runAsync(ctx, async () => {
                const done = await cutWaveFor(f.app, f.user, repo);
                if (!done.ok) return void ctx.toast(done.error, "danger");
                await reload();
                const number = done.value.number;
                ctx.push(
                  confirmScreen(ctx, self, {
                    title: "Wave drafted",
                    body: [`Draft pull #${number} holds wave ${done.value.version}.`],
                    actions: [{ label: "Open" }, { label: "Close" }],
                    onChoose: (c) => {
                      if (c === 0) ctx.push(pullScreen(f, ctx, src, number));
                    },
                  }),
                );
              });
      };
      ctx.push(
        yesNo(
          ctx,
          confirmScreen(ctx, self, {
            title: "Cut wave",
            body: [
              `${plural(pulls, "pull")} since the last wave would go into it.`,
              `cut wave ${version}? y/n`,
            ],
            actions: [{ label: "Cut" }, { label: "Cancel" }],
            onChoose: choose,
          }),
          choose,
        ),
      );
    });
  };

  const self: Screen = {
    title: "Waves",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["c"], "cut a wave"),
      binding(["r"], "refresh"),
    ],
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, head, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      s.text(
        head!.x,
        head!.y,
        truncate(
          `${sourceName(src)} · ${plural(entries.length, "wave")}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (entries.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No waves yet" : "Reading…",
          body: !loaded
            ? ""
            : repo === undefined
              ? "Waves are only read on this forge."
              : NO_WAVES,
        });
        return;
      }
      const rows = waveRows(entries);
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, { open: openAt });
    },
    key(e) {
      if (state.key(e, entries.length)) return true;
      if (e.key === "enter") {
        openAt(state.index);
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      if (e.key === "c") {
        cut();
        return true;
      }
      return false;
    },
  };
  return self;
}
