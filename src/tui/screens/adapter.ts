/**
 * An app's adapter in the terminal (#10037): the facts the app page shows
 * (`web/studio/adapter.ts`), read from the same `adapterFactsOf` and
 * gated the same way — owner facts (`canSeeOwnerFacts`) only. The palette
 * offers it while a repository with an app is open; anyone else is offered
 * nothing and, were the screen reached, sees no rows. Read-only.
 */

import { adapterFactsOf, adapterRows, type AdapterFacts } from "../../apps/adapter_facts.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { drawFacts } from "./common.ts";

const mayRead = (f: Session, repo: Repo): boolean => canSeeOwnerFacts(f.db, repo, f.user);

/** The palette's "Adapter", while a repository is open, to those who see its owner facts. */
export function adapterCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayRead(f, repo) || getAppByRepo(f.db, repo.id) === undefined) return [];
  return [
    {
      id: "adapter",
      title: `${repo.ownerName}/${repo.name} — Adapter`,
      hint: "source, last pull, next pull and cursor",
      run: () => ctx.push(adapterScreen(f, ctx, repo)),
    },
  ];
}

/** `facts` is the read; a test passes its own so the gate is checked without a git repository. */
export function adapterScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  facts: (record: AppRecord) => Promise<AdapterFacts | undefined> = (record) => adapterFactsOf(f.app, record),
): Screen {
  let rows: Array<[string, string]> | undefined;
  let loaded = false;
  const load = (): void => {
    const record = mayRead(f, repo) ? getAppByRepo(f.db, repo.id) : undefined;
    if (record === undefined) {
      loaded = true;
      return;
    }
    void facts(record).then(
      (read) => {
        rows = read === undefined ? undefined : adapterRows(read);
        loaded = true;
        ctx.invalidate();
      },
      () => {
        loaded = true;
        ctx.invalidate();
      },
    );
  };
  load();
  return {
    title: `${repo.ownerName}/${repo.name} — Adapter`,
    keys: [],
    render(area, s) {
      const c = ctx.theme.c;
      if (rows === undefined) {
        const said = loaded ? "This app declares no adapter." : "Reading…";
        s.text(area.x, area.y, truncate(said, area.w), style(c.mutedFg, c.bg), area.x + area.w);
        return;
      }
      drawFacts(s, area, c, rows);
    },
    key: () => false,
  };
}
