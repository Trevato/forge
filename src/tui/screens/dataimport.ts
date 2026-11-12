/**
 * An app's database import in the terminal (#11697): the same
 * `importAppData` as `POST …/data-import` and MCP `app_data_import`, an
 * admin's only. A person who is not the repository's admin is offered
 * nothing. A terminal cannot paste a dump, so `i` asks for the name of a
 * `.sql` file already in the app's `imports/` directory (`apps/dump_file.ts`);
 * `r` does the same and replaces an existing store, keeping the old file as
 * `<file>.before-import-<time>`. The answer is the API's: per table, the
 * dump's rows and checksum, the store's, and whether they match.
 */

import { importAppData, importDataMessage } from "../../actions/migrate.ts";
import { envDataDir } from "../../apps/data.ts";
import { DUMP_FILE_WORDS, readStagedDump } from "../../apps/dump_file.ts";
import type { ImportReport } from "../../apps/dump_import.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

/** Whether this viewer may import: the repository's admin, and it is an app. */
export function mayImport(f: Session, repo: Repo | undefined): repo is Repo {
  return (
    repo !== undefined &&
    f.user !== undefined &&
    getAppByRepo(f.app.db, repo.id) !== undefined &&
    canAdmin(f.app.db, repo, f.user)
  );
}

/** What an import's report says, a row per table. */
export function reportRows(report: ImportReport): ListRow[] {
  return report.tables.map((t) => ({
    title: `${t.table}: ${t.rows} rows`,
    tone: t.match ? "success" : "danger",
    note: `dump ${t.sha256.slice(0, 16)}  store ${t.store?.sha256.slice(0, 16) ?? "missing"}  counted in dump ${t.inserted}`,
    ...(t.match ? {} : { meta: "mismatch" }),
  }));
}

/** Run an import from a staged file for this viewer: the report, or the words to say. */
export function importStaged(
  f: Session,
  repo: Repo,
  name: string,
  replace: boolean,
): { ok: true; report: ImportReport } | { ok: false; words: string } {
  const record = getAppByRepo(f.app.db, repo.id);
  if (record === undefined || !canAdmin(f.app.db, repo, f.user)) return { ok: false, words: "No such repository, or you are not its admin." };
  const read = readStagedDump(envDataDir(f.app.config.dataDir, record.id, "production"), name);
  if (!read.ok) return { ok: false, words: DUMP_FILE_WORDS[read.error] };
  const done = importAppData(f.app, f.user, repo, { dump: read.sql, replace });
  return done.ok ? { ok: true, report: done.value } : { ok: false, words: importDataMessage(done.error) };
}

export function dataImportScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let rows: ListRow[] = [];
  let note = "i loads a .sql file from the app's imports/ directory; r loads it over an existing store.";
  const ask = (replace: boolean): Screen =>
    promptScreen(ctx, screen, {
      title: replace ? "Import and replace" : "Import a dump",
      label: "file in imports/, like dump.sql",
      placeholder: "dump.sql",
      onSubmit: (name) => {
        if (name === "") return "Name a file.";
        const done = importStaged(f, repo, name, replace);
        if (!done.ok) return done.words;
        rows = reportRows(done.report);
        note = `Loaded ${done.report.statements} statements into ${done.report.file}${done.report.kept ? `; the old file is ${done.report.kept}` : ""}.`;
        ctx.invalidate();
        return undefined;
      },
    });
  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} — Database import`,
    keys: [binding(["i"], "import"), binding(["r"], "import, replace"), binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(mayImport(f, repo) ? note : "Only the app's admin imports a database.", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || (e.key !== "i" && e.key !== "r")) return false;
      if (!mayImport(f, repo)) {
        ctx.toast("Only the app's admin imports a database.", "danger");
        return true;
      }
      ctx.push(ask(e.key === "r"));
      return true;
    },
  };
  return screen;
}

/** The palette's command: an admin of a repository that is an app. */
export function dataImportCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (!mayImport(f, repo)) return [];
  return [
    {
      id: "data-import",
      title: `${repo.ownerName}/${repo.name} — Database import`,
      hint: "load a SQL dump into the app's store, counts and checksums on both sides",
      run: () => ctx.push(dataImportScreen(f, ctx, repo)),
    },
  ];
}
