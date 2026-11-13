/**
 * Releases, the terminal's /releases: the live line, then each kept release
 * (short sha, the pull that landed it, when, healthy since). Gated by
 * `release/gate.ts` as the page is: a site admin or a reader of FORGE_REPO
 * sees it; Enter rolls back only for a person who writes that repository, on
 * a kept release the live schema allows, through the page's own rollback.
 */

import { getRepoById } from "../../core/repos.ts";
import { running } from "../../kernel/version.ts";
import { BOOTED, canRollBackTo, mayRead, mayRollBack, rollBackTo } from "../../release/gate.ts";
import { listReleases, type Release } from "../../release/record.ts";
import { lastProof } from "../../release/prove.ts";
import { journeyLine, liveSince, NO_RELEASES_YET, plain } from "../../release/words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, confirmScreen, drawList, hitList, ago, metaOf, runAsync, type ListRow } from "./common.ts";

export interface ReleaseLine {
  readonly release: Release;
  readonly live: boolean;
  /** Whether Enter may roll back to it, for this person. */
  readonly rollable: boolean;
}

/** The live line (`liveSince`), or nothing when no release is known to be live. */
export function liveText(f: Session): string | undefined {
  const live = running().commit;
  return live === null || !mayRead(f.app, f.user) ? undefined : liveSince(plain, live.slice(0, 7), ago(BOOTED));
}

/** The proven stranger's journey line for the serving version (`journeyLine`), or undefined without timings. */
export function journeyText(f: Session): string | undefined {
  const p = lastProof(f.app.config.dataDir);
  if (p === undefined || !p.ok || p.version !== running().version || !mayRead(f.app, f.user)) return undefined;
  return journeyLine(plain, p.journey, (n) => n);
}

/** The kept releases this person may see; none at all for anyone the page would 404. */
export async function readReleases(f: Session): Promise<ReleaseLine[]> {
  if (!mayRead(f.app, f.user)) return [];
  const live = running().commit;
  const writer = mayRollBack(f.app, f.user);
  const lines: ReleaseLine[] = [];
  for (const release of listReleases(f.db)) {
    const isLive = live !== null && release.sha === live;
    lines.push({
      release,
      live: isLive,
      rollable: writer && !isLive && (await canRollBackTo(f.app, release)),
    });
  }
  return lines;
}

export function releaseRows(f: Session, lines: readonly ReleaseLine[]): ListRow[] {
  return lines.map(({ release: r, live }) => {
    const repo = getRepoById(f.db, r.repoId);
    const pull = r.pullNumber === null ? "no pull" : `${repo ? `${repo.ownerName}/${repo.name}` : "pull"} #${r.pullNumber}`;
    return {
      title: r.sha.slice(0, 7),
      tone: live ? "success" : r.ok ? "default" : "danger",
      meta: metaOf(
        pull,
        `landed ${ago(r.createdAt)}`,
        live ? `healthy since ${ago(BOOTED)}` : "",
        r.ok ? "" : "preflight failed",
      ),
    } satisfies ListRow;
  });
}

export function releasesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let lines: ReleaseLine[] = [];
  let loaded = false;
  const read = async (): Promise<void> => {
    lines = await readReleases(f);
    state.clamp(lines.length);
    loaded = true;
    ctx.invalidate();
  };
  const self: Screen = {
    title: "Releases",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "roll back"), binding(["esc", "q"], "close")],
    load: read,
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate([liveText(f), journeyText(f)].filter((x) => x !== undefined).join(" · "), head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (lines.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No releases yet" : "Reading…",
          body: NO_RELEASES_YET,
        });
        return;
      }
      drawList(s, body!, c, state, releaseRows(f, lines));
      hitList(ctx, body!, state, lines.length, { open: (i) => ask(i) });
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") ask(state.index);
      else state.key(e, lines.length);
      return true;
    },
  };
  const ask = (index: number): void => {
    const line = lines[index];
    const user = f.user;
    if (line === undefined || user === undefined || !line.rollable) return;
    // Re-checked at the act: the list is a snapshot, the gate is not.
    if (!mayRollBack(f.app, user)) return;
    const sha = line.release.sha;
    ctx.push(
      confirmScreen(ctx, self, {
        title: "Roll back",
        body: [`Swap to ${sha.slice(0, 7)} and stop this process?`],
        actions: [{ label: "Roll back", variant: "danger" }, { label: "Cancel" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 0) return;
          runAsync(ctx, async () => {
            const done = await rollBackTo(f.app, user, sha);
            ctx.toast(done.ok ? `Rolled back to ${sha.slice(0, 7)}; it reads healthy.` : done.line, done.ok ? "default" : "danger");
          });
        },
      }),
    );
  };
  return self;
}
