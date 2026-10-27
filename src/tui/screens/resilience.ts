/**
 * The Resilience command's dialog, a forge admin's: one line per THREATS.md
 * protection with its standing in the last gate, as /resilience says it.
 * Enter, Esc or q closes it.
 *
 * Above the protections, the newest snapshots, newest first. A forge admin
 * takes one now with `n` and brings the mirror level with `l`, each after a
 * `y/n` asked on the dialog's first line, through `actions/backups_now.ts` —
 * MCP `snapshot_now`'s and `mirror_now`'s actions — and the answer is said
 * there in the page's words. While one runs, neither key is offered. The
 * command is a forge admin's only (`tui/forge.ts`), and the actions refuse
 * anyone else again.
 *
 * A forge admin who is a person also sees where the off-box snapshot mirror
 * is, `M` seals it (five prompts, the secret masked, a blank keeps what was
 * sealed) and `F` forgets it after a confirm; the rules are
 * `actions/mirror.ts`, the Backups page's and MCP `mirror_set`'s. No key is
 * ever drawn or read back.
 */

import { mirrorNow, recentSnapshots, snapshotNow } from "../../actions/backups_now.ts";
import { forgetMirror, saveMirror } from "../../actions/mirror.ts";
import type { DestinationInput } from "../../actions/destination.ts";
import { snapshotsOf } from "../../snapshot/service.ts";
import { readResilience } from "../../checks/resilience.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { pad, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { confirmScreen, later, promptScreen, runAsync } from "./common.ts";

const WIDTH = 72;
const INNER = WIDTH - 6;
/** How many of the newest snapshots the dialog lists. */
const SNAPSHOTS = 3;

export function resilienceLines(dataDir: string): string[] {
  const rows = readResilience(dataDir);
  return rows.flatMap(({ p, s }) => wrap(`${pad(s, 11)} ${p.text}`, INNER));
}

/** Where the mirror is, or that there is none; never a key. */
export function mirrorLine(f: Session): string {
  const where = snapshotsOf(f.app)?.mirror?.where;
  return where === undefined ? "Mirror: none." : `Mirror: ${where}`;
}

const FIELDS = [
  ["endpoint", "endpoint (https://…)", false],
  ["bucket", "bucket", false],
  ["region", "region", false],
  ["accessKey", "access key", true],
  ["secretKey", "secret key", true],
] as const;

type Asking = "snapshot" | "mirror";

const QUESTION: Record<Asking, string> = {
  snapshot: "take a snapshot now? y/n",
  mirror: "bring the mirror level now? y/n",
};

export function resilienceScreen(f: Session, ctx: Ctx): Screen {
  const mayMirror = f.user?.isAdmin === true && f.user.kind === "user";
  /** The newest snapshots, `unreadable` when the store could not be listed; undefined until read. */
  let snapshots: string[] | "unreadable" | undefined;
  let asking: Asking | undefined;
  // While an action runs, `n` and `l` are ignored: a second would queue behind it.
  let busy = false;
  let said = "";
  let note = "";

  const read = async (): Promise<void> => {
    const listed = await recentSnapshots(f.app, f.user, SNAPSHOTS);
    snapshots = listed.ok ? listed.value : "unreadable";
    ctx.invalidate();
  };

  const act = (what: Asking): void => {
    busy = true;
    said = what === "snapshot" ? "Taking a snapshot…" : "Bringing the mirror level…";
    ctx.invalidate();
    runAsync(ctx, async () => {
      try {
        if (what === "snapshot") {
          const taken = await snapshotNow(f.app, f.user);
          said = taken.ok ? taken.value.says : taken.error.says;
        } else {
          const level = await mirrorNow(f.app, f.user);
          said = level.ok ? level.value.says : level.error.says;
        }
        await read();
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
  };

  const body = (): string[] => {
    // The question and the answer come first: a long list must not clip them.
    const out: string[] = [];
    if (asking !== undefined) out.push(QUESTION[asking], "");
    else if (said !== "") out.push(...wrap(said, INNER), "");
    out.push(...wrap(mirrorLine(f), INNER));
    if (mayMirror) out.push("M sets the mirror, F forgets it.");
    if (note !== "") out.push(...wrap(note, INNER));
    out.push("", "Snapshots, newest first:");
    if (snapshots === undefined) out.push("  reading…");
    else if (snapshots === "unreadable") out.push("  the snapshots could not be read");
    else if (snapshots.length === 0) out.push("  none kept");
    else out.push(...snapshots.map((s) => `  ${s}`));
    out.push("", ...resilienceLines(f.app.config.dataDir));
    return out;
  };

  const screen: Screen = {
    title: "Resilience",
    get keys() {
      if (asking !== undefined) return [binding(["y"], "yes"), binding(["n", "esc"], "no")];
      return [
        ...(busy ? [] : [binding(["n"], "take a snapshot now"), binding(["l"], "bring the mirror level now")]),
        ...(mayMirror ? [binding(["m"], "set the mirror"), binding(["f"], "forget the mirror")] : []),
        binding(["enter", "esc", "q"], "close"),
      ];
    },
    load: read,
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Resilience",
        body: body(),
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (asking !== undefined) {
        const was = asking;
        asking = undefined;
        if (e.key === "y") act(was);
        return true;
      }
      if ((e.key === "n" || e.key === "l") && !busy) {
        asking = e.key === "n" ? "snapshot" : "mirror";
        said = "";
      } else if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      else if (mayMirror && e.key === "m") ctx.push(ask(0, {}));
      else if (mayMirror && e.key === "f")
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Forget the mirror?",
            body: ["The sealed mirror settings are cleared;", "snapshots stay only on this machine."],
            actions: [{ label: "Cancel", variant: "ghost" }, { label: "Forget", variant: "danger" }],
            onChoose: (i) => {
              if (i !== 1) return;
              note = forgetMirror(f.app, f.user).ok ? "The sealed mirror is cleared." : "Not found.";
            },
          }),
        );
      return true;
    },
  };
  // One field at a time; the last submit seals, and a refusal keeps that prompt open.
  const ask = (n: number, got: Record<string, string>): Screen => {
    const [name, label, mask] = FIELDS[n]!;
    return promptScreen(ctx, screen, {
      title: `Mirror ${n + 1}/${FIELDS.length}`,
      label,
      hint: "blank keeps what was sealed",
      mask,
      onSubmit: (value) => {
        const next = { ...got, [name]: value };
        if (n + 1 < FIELDS.length) return later(ctx, () => ask(n + 1, next));
        const input: DestinationInput = {
          endpoint: next["endpoint"] ?? "",
          bucket: next["bucket"] ?? "",
          region: next["region"] ?? "",
          accessKey: next["accessKey"] ?? "",
          secretKey: next["secretKey"] ?? "",
        };
        const saved = saveMirror(f.app, f.user, input);
        if (!saved.ok) return saved.error === "not_found" ? "Not found." : saved.error;
        note = saved.value;
        return undefined;
      },
    });
  };
  return screen;
}
