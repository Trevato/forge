/**
 * An app's terminal from inside the forge's: `t` suspends the UI, runs the
 * app's `tty` on the same pty, and brings the UI back when it exits. One
 * connection, two programs in turn — the way `$FORGE_EDITOR` already runs —
 * so a preview is one keystroke away from the pull that made it.
 */

import { runAppTty, ttyRefusalText } from "../../apps/tty.ts";
import { envHostLabel, type EnvName } from "../../apps/data.ts";
import { getAppByRepo } from "../../core/apps.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../app/app.ts";
import type { Session } from "../session.ts";

export async function openAppTerminal(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  env: EnvName,
): Promise<void> {
  const record = getAppByRepo(f.db, repo.id);
  if (record === undefined) {
    ctx.toast("this repository is not an app", "attn");
    return;
  }
  const name = envHostLabel(record.slug, env);
  const ran = await ctx.suspend((host) =>
    runAppTty(f.app, host, f.user, { app: record, env }),
  );
  if (ran === undefined) {
    ctx.toast("another program is already running on this session", "attn");
    return;
  }
  if (!ran.ok) {
    ctx.toast(
      ttyRefusalText(ran.error.refusal, name, ran.error.detail),
      "attn",
    );
    return;
  }
  if (ran.value !== 0)
    ctx.toast(`${name}'s terminal exited with ${ran.value}`, "attn");
}
