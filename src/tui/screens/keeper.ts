/**
 * The release keeper in the terminal (#7557), the /releases card's read:
 * what holds the next cut, the release tick's heartbeat and whether main is
 * green and ahead of production (#11507), then each release the keeper cut with its stage,
 * its short commit, landed to live (#8042), the known-good version it rolls
 * back to and what the probes counted.
 * Gated by `release/gate.ts` as the page is. `h` holds releases with a
 * reason and `h` with `lift N` lifts an owner's hold; `now: reason` asks
 * for a cut at the next tick (#11839), through the same functions the card and
 * MCP `release_hold` and `release_now` call.
 */

import { aheadLine } from "../../flow/alarm_main_ahead.ts";
import { neverTickedLine } from "../../keeper/at_boot.ts";
import { beatLine, lastBeat } from "../../keeper/beat.ts";
import { stallWords } from "../../perf/boot_stall.ts";
import { blocking, holdAs, liftAs, standingHolds } from "../../keeper/hold.ts";
import { secondsWords, withLandedToLive, type LandedRelease } from "../../keeper/landed.ts";
import { releaseNowAs, pendingNow } from "../../keeper/now.ts";
import { listKeeperReleases, type Stage } from "../../keeper/record.ts";
import { mayRead, mayRollBack } from "../../release/gate.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState, type Tone } from "../ui/widgets.ts";
import { ListState, ago, drawList, metaOf, promptScreen, type ListRow } from "./common.ts";

const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  rolling: { label: "rolling", tone: "default" },
  verifying: { label: "verifying", tone: "default" },
  verified: { label: "verified live", tone: "success" },
  rolled_back: { label: "rolled back", tone: "danger" },
};

export interface KeeperRead {
  /** What holds the next cut, or the line that says nothing does. */
  readonly blocked: string;
  /** The release tick's last heartbeat as a sentence, said plainly when there is none or it is old. */
  readonly heartbeat: string;
  /** Main green and ahead of production, and for how long; absent when it is not. */
  readonly ahead?: string;
  /** A standing release-now request, said plainly; absent when there is none. */
  readonly asked?: string;
  readonly releases: readonly LandedRelease[];
}

/** The card's content for this person; undefined for anyone the page would 404. */
export function readKeeper(f: Session, now: Date = new Date()): KeeperRead | undefined {
  if (!mayRead(f.app, f.user)) return undefined;
  const ahead = aheadLine(f.db, now);
  const asked = pendingNow(f.db, now.getTime());
  const beat = lastBeat(f.db);
  // Never heard from: the same keeper line /releases and the main-ahead alarm name (#11924).
  const never = beat === null ? neverTickedLine() : undefined;
  return {
    blocked: blocking(standingHolds(f.db)) ?? "Nothing holds the next cut.",
    heartbeat: never === undefined ? beatLine(beat, now) : `${beatLine(beat, now)} ${never[0]!.toUpperCase()}${never.slice(1)}.`,
    ...(ahead === undefined ? {} : { ahead }),
    ...(asked === undefined ? {} : { asked: `Release now asked by ${asked.by}: ${asked.reason}` }),
    releases: withLandedToLive(f.db, listKeeperReleases(f.db)),
  };
}

export function keeperRows(releases: readonly LandedRelease[]): ListRow[] {
  return releases.map((r, i) => ({
    title: r.version,
    tone: STAGE[r.stage].tone,
    meta: metaOf(
      STAGE[r.stage].label,
      r.commit,
      `cut ${ago(r.cutAt)}`,
      r.landedToLiveSeconds === null ? "not live yet" : `landed to live ${secondsWords(r.landedToLiveSeconds)}`,
      `known good ${r.knownGood.version}`,
      `roll ${r.rollNon200}/${r.rollProbes} non-200`,
      `${r.probes} probes, ${r.pages} pages`,
      `worst ${r.worstMs} ms`,
      r.worstStallMs === 0 ? "" : `boot stall ${stallWords(r.worstStallMs, releases[i + 1]?.worstStallMs)}`,
      `${r.secondsDark} s dark`,
    ),
  }));
}

/** One line of the hold prompt: a reason holds, `lift N` lifts; the sentence to show. */
export function holdLine(f: Session, text: string): { ok: boolean; says: string } {
  const lifting = /^lift\s+#?(\d+)$/i.exec(text.trim());
  if (lifting !== null) {
    const done = liftAs(f.app, f.user, Number(lifting[1]));
    return done.ok ? { ok: true, says: `Hold ${done.value} lifted.` } : { ok: false, says: done.message };
  }
  const now = /^now:\s*(.*)$/is.exec(text.trim());
  if (now !== null) {
    const asked = releaseNowAs(f.app, f.user, now[1]!);
    return asked.ok ? { ok: true, says: `Release asked for now: ${asked.value.reason}` } : { ok: false, says: asked.message };
  }
  const held = holdAs(f.app, f.user, text);
  return held.ok ? { ok: true, says: `Releases held: ${held.value.reason}` } : { ok: false, says: held.message };
}

export function keeperScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let read: KeeperRead | undefined;
  const refresh = (): void => {
    read = readKeeper(f);
    state.clamp(read?.releases.length ?? 0);
    ctx.invalidate();
  };
  const screen: Screen = {
    title: "Release keeper",
    keys: [binding(["j", "k"], "move"), ...(mayRollBack(f.app, f.user) ? [binding(["h"], "hold / lift / now")] : []), binding(["esc", "q"], "close")],
    load: async () => refresh(),
    render(area, s) {
      const c = ctx.theme.c;
      if (read === undefined) {
        emptyState(s, area, c, { title: "Not yours to see", body: "The release keeper is for the forge's administrators and its repository's readers." });
        return;
      }
      // What holds the cut ends with what to land ("release hold N"): wrapped, up to three lines, never cut short of it.
      const lines = [
        ...wrap(read.blocked, area.w).slice(0, 3),
        ...wrap(read.heartbeat, area.w).slice(0, 2),
        ...(read.ahead === undefined ? [] : wrap(read.ahead, area.w).slice(0, 2)),
        ...(read.asked === undefined ? [] : wrap(read.asked, area.w).slice(0, 2)),
      ];
      const [head, body] = split(area, "v", [len(lines.length + 1), fill(1)]);
      lines.forEach((l, i) => s.text(head!.x, head!.y + i, truncate(l, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w));
      if (read.releases.length === 0) {
        emptyState(s, body!, c, { title: "No keeper releases yet", body: "The keeper cuts when main has moved past a live tag (FORGE_RELEASE_KEEPER=on)." });
        return;
      }
      drawList(s, body!, c, state, keeperRows(read.releases));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "h" && mayRollBack(f.app, f.user))
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Hold releases",
            label: "a reason holds the next cut · lift N lifts a hold · now: reason cuts now",
            onSubmit: (text) => {
              const done = holdLine(f, text);
              if (!done.ok) return done.says;
              ctx.toast(done.says);
              refresh();
              return undefined;
            },
          }),
        );
      else state.key(e, read?.releases.length ?? 0);
      return true;
    },
  };
  return screen;
}
