/**
 * The Resilience command's dialog, a forge admin's: one line per THREATS.md
 * protection with its standing in the last gate, as /resilience says it.
 * Enter, Esc or q closes it. A forge admin who is a person also sees where the
 * off-box snapshot mirror is, `M` seals it (five prompts, the secret masked,
 * a blank keeps what was sealed) and `F` forgets it after a confirm; the
 * rules are `actions/mirror.ts`, the Backups page's and MCP `mirror_set`'s.
 * No key is ever drawn or read back.
 */

import { forgetMirror, saveMirror } from "../../actions/mirror.ts";
import type { DestinationInput } from "../../actions/destination.ts";
import { snapshotsOf } from "../../snapshot/service.ts";
import type { Session } from "../session.ts";
import { confirmScreen, later, promptScreen } from "./common.ts";
import { readResilience } from "../../checks/resilience.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { pad, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";

const WIDTH = 72;

export function resilienceLines(dataDir: string): string[] {
  const rows = readResilience(dataDir);
  const inner = WIDTH - 6;
  return rows.flatMap(({ p, s }) => wrap(`${pad(s, 11)} ${p.text}`, inner));
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

export function resilienceScreen(f: Session, ctx: Ctx): Screen {
  const mayMirror = f.user?.isAdmin === true && f.user.kind === "user";
  let note = "";
  const screen: Screen = {
    title: "Resilience",
    keys: [
      ...(mayMirror ? [binding(["m"], "set the mirror"), binding(["f"], "forget the mirror")] : []),
      binding(["enter", "esc", "q"], "close"),
    ],
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Resilience",
        body: [
          ...wrap(mirrorLine(f), WIDTH - 6),
          ...(mayMirror ? ["M sets the mirror, F forgets it."] : []),
          ...(note === "" ? [] : wrap(note, WIDTH - 6)),
          "",
          ...resilienceLines(f.app.config.dataDir),
        ],
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
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
