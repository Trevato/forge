/**
 * An app's adapter in the terminal (#10037): the facts the app page shows
 * (`web/studio/adapter.ts`), read from the same `adapterFactsOf` and
 * gated the same way — owner facts (`canSeeOwnerFacts`) only. The palette
 * offers it while a repository with an app is open; anyone else is offered
 * nothing and, were the screen reached, sees no rows. A writer presses `p`
 * to run a pull now (`pullNow`, #10126): the rows are read again, a refusal
 * is told in `PULL_NOW_REFUSALS`' words. Anyone else is shown no key and
 * `p` does nothing.
 */

import { pullNow, PULL_NOW_REFUSALS } from "../../actions/app_pull.ts";
import { binding } from "../app/keys.ts";
import { NO_RUNS_WORDS, adapterFactsOf, adapterRows, adapterRunRows, type AdapterFacts } from "../../apps/adapter_facts.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import { canSeeOwnerFacts, canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { Scroll, drawFacts, drawLines } from "./common.ts";

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
  pull: typeof pullNow = pullNow,
): Screen {
  const mayPull = (): boolean => f.user !== undefined && canWrite(f.db, repo, f.user);
  let pulling = false;
  const scroll = new Scroll();
  let rows: Array<[string, string]> | undefined;
  let runRows: Array<[string, string]> = [];
  let loaded = false;
  const load = (): void => {
    const record = mayRead(f, repo) ? getAppByRepo(f.db, repo.id) : undefined;
    if (record === undefined) {
      loaded = true;
      return;
    }
    void facts(record).then(
      (read) => {
        rows =
          read === undefined
            ? undefined
            : [...adapterRows(read), ["Pull runs", (read.runs ?? []).length === 0 ? NO_RUNS_WORDS : ""]];
        runRows = read === undefined ? [] : adapterRunRows(read);
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
    get keys() {
      return mayPull() ? [binding(["p"], "pull now")] : [];
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (rows === undefined) {
        const said = loaded ? "This app declares no adapter." : "Reading…";
        s.text(area.x, area.y, truncate(said, area.w), style(c.mutedFg, c.bg), area.x + area.w);
        return;
      }
      drawFacts(s, area, c, rows);
      const top = rows.length;
      if (top >= area.h || runRows.length === 0) return;
      const lines = runRows.map(([when, words]) => [
        { text: truncate(`${when.slice(0, 16).replace("T", " ")}  ${words}`, Math.max(0, area.w - 1)), style: style(c.fg, c.bg) },
      ]);
      drawLines(s, { ...area, y: area.y + top, h: area.h - top }, c, scroll, lines);
    },
    key(e) {
      if (rows !== undefined && scroll.key(e, runRows.length)) return true;
      if (e.key !== "p" || !mayPull()) return false;
      if (pulling) return true;
      pulling = true;
      void pull(f.app, f.user, repo).then(
        (done) => {
          pulling = false;
          if (done.ok) {
            ctx.toast(`pulled: ${done.value.state}`, "success");
            load();
          } else ctx.toast(PULL_NOW_REFUSALS[done.error], "danger");
        },
        () => {
          pulling = false;
          ctx.toast("The pull could not be run.", "danger");
        },
      );
      return true;
    },
  };
}
