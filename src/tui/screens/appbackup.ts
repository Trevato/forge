/**
 * An app's encrypted backup in the terminal, an admin's (#11701): the same
 * seal and restore proof as `scripts/app-backup.ts` (`apps/backup.ts`), from a
 * repository's `:` palette. `s` seals the app's production data and proves it
 * (and the data left behind) before keeping the file; `p` proves the backup
 * under the cursor. The passphrase is typed masked, held in a closure for one
 * call, and never stored, drawn, toasted or logged.
 */

import { listBackups, proveApp, sealApp, type BackupFile } from "../../apps/backup_door.ts";
import { proofLines } from "../../apps/backup_words.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

/** The palette's "Back up data", for an admin of a repository that is an app. */
export function appBackupCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined) return [];
  if (getAppByRepo(f.app.db, repo.id) === undefined || !canAdmin(f.app.db, repo, f.user)) return [];
  return [
    {
      id: "app-backup",
      title: `${repo.ownerName}/${repo.name} — Back up data`,
      hint: "seal the app's data under your passphrase and prove it restores",
      run: () => ctx.push(appBackupScreen(f, ctx, repo)),
    },
  ];
}

export function appBackupScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const app = getAppByRepo(f.app.db, repo.id);
  const dataDir = f.app.config.dataDir;
  let rows: BackupFile[] = [];
  let note: string[] = [];
  const reload = (): void => {
    rows = app === undefined ? [] : listBackups(dataDir, app.id);
    state.clamp(rows.length);
    ctx.invalidate();
  };
  reload();
  const allowed = (): boolean => f.user !== undefined && canAdmin(f.app.db, repo, f.user);
  const ask = (title: string, go: (pass: string) => Promise<void>): Screen =>
    promptScreen(ctx, screen, {
      title,
      label: "your passphrase (12 characters at least; the forge never keeps it)",
      mask: true,
      onSubmit: (pass) => {
        if (pass.length < 12) return "The passphrase is under 12 characters.";
        return go(pass);
      },
    });
  const report = (r: Awaited<ReturnType<typeof sealApp>>): void => {
    note = typeof r === "string" ? [r] : proofLines(r);
    reload();
  };

  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} — Back up data`,
    keys: [binding(["s"], "seal and prove"), binding(["p"], "prove this one"), binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const shown = note.slice(0, 8);
      const [head, list, foot] = split(area, "v", [len(1), fill(1), len(Math.max(1, shown.length))]);
      s.text(
        head!.x,
        head!.y,
        truncate(rows.length === 0 ? "No backup yet. s seals production data." : "s seals again, p proves the one under the cursor.", head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      const lines: ListRow[] = rows.map((r) => ({ title: r.name, meta: `${r.bytes} bytes · ${r.at.slice(0, 16).replace("T", " ")} UTC` }));
      drawList(s, list!, c, state, lines);
      shown.forEach((l, i) => s.text(foot!.x, foot!.y + i, truncate(l, foot!.w), style(c.fg, c.bg), foot!.x + foot!.w));
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || (e.key !== "s" && e.key !== "p")) return false;
      if (app === undefined || !allowed()) {
        ctx.toast("An admin of the app backs it up.", "danger");
        return true;
      }
      if (e.key === "s") {
        ctx.push(
          ask("Seal this app's data", (pass) =>
            sealApp(dataDir, app.id, pass).then(report),
          ),
        );
        return true;
      }
      const at = rows[state.index];
      if (at === undefined) return true;
      ctx.push(
        ask(`Prove ${at.name}`, (pass) =>
          proveApp(dataDir, app.id, at.name, pass).then(report),
        ),
      );
      return true;
    },
  };
  return screen;
}
