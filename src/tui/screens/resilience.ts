/**
 * The Resilience command's dialog, a forge admin's: the backups line /resilience
 * opens with (`snapshot/backups_line.ts`), where snapshots go now and
 * where the off-box mirror is, the newest snapshots, then one line per
 * THREATS.md protection with its standing in the last gate, as /resilience
 * says it. Enter, Esc or q closes it.
 *
 * A forge admin takes a snapshot now with `n`, brings the mirror level with
 * `l` and runs a restore drill with `r`, each after a `y/n` asked on the
 * dialog's first line, through `actions/backups_now.ts` — MCP `snapshot_now`'s
 * and `mirror_now`'s actions, and the Backups page's drill — and the answer is
 * said there in the page's words. While one runs, none of the keys is offered.
 *
 * For an admin who is a person, `d` sets the destination and `x` forgets it
 * after a confirm, through `actions/destination.ts`; `m` seals the mirror and
 * `f` forgets it, through `actions/mirror.ts` — the Backups page's and MCP's
 * rules and words. Each asks five prompts (endpoint, bucket, region, access
 * key, secret key — both keys typed masked; a blank keeps what was sealed).
 * `t` tries the destination in effect, as `testDestination` says it.
 * A key is never drawn, kept past the save, or put in a note.
 */

import { drillNow, mirrorNow, recentSnapshots, snapshotNow } from "../../actions/backups_now.ts";
import { readResilience } from "../../checks/resilience.ts";
import {
  forgetDestination,
  invalidField,
  mayChangeDestination,
  saveDestination,
  testDestination,
  type DestinationInput,
} from "../../actions/destination.ts";
import { forgetMirror, saveMirror } from "../../actions/mirror.ts";
import { backupsLine } from "../../snapshot/backups_line.ts";
import { backupVerdict } from "../../snapshot/bucket.ts";
import { lastDrill } from "../../snapshot/drills.ts";
import { resolveDestination } from "../../snapshot/destination.ts";
import { snapshotsOf } from "../../snapshot/service.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { pad, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { confirmScreen, later, promptScreen, runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const WIDTH = 72;
const INNER = WIDTH - 6;
/** How many of the newest snapshots the dialog lists. */
const SNAPSHOTS = 3;

export function resilienceLines(dataDir: string): string[] {
  const rows = readResilience(dataDir);
  return rows.flatMap(({ p, s }) => wrap(`${pad(s, 11)} ${p.text}`, INNER));
}

/** The source of the destination in effect, in the Backups page's words. */
const SOURCE: Record<string, string> = {
  sealed: "sealed in this forge",
  dir: "the directory named by FORGE_SNAPSHOT_DIR",
  env: "the host's S3_* environment variables",
};

/** Where snapshots go now — kind and place — or that they stay on this box. Never a key. */
export function destinationLine(f: Session): string {
  const dest = resolveDestination({ db: f.app.db, dataDir: f.app.config.dataDir, bus: f.app.bus });
  return dest === undefined
    ? "Snapshots stay on this box: no destination is set."
    : `Snapshots go to ${dest.store.where} (${SOURCE[dest.source] ?? dest.source}).`;
}

/** Where the mirror is, or that there is none; never a key. */
export function mirrorLine(f: Session): string {
  const where = snapshotsOf(f.app)?.mirror?.where;
  return where === undefined ? "Mirror: none." : `Mirror: ${where}`;
}

/** The bucket's verdict, as home and the MCP's `backups` say it: the line, each lane's newest, what is wrong. */
export function verdictLines(f: Session): string[] {
  const v = backupVerdict(f.app.config.dataDir, lastDrill(f.app.db));
  const mark = v.state === "red" ? "RED" : v.state === "unknown" ? "unknown" : "ok";
  return [
    ...wrap(`Backups ${mark}: ${v.line}`, INNER),
    ...wrap(`  ${v.checkLine}`, INNER),
    ...v.lanes.flatMap((l) => wrap(`  ${l.state === "red" ? "!" : " "} ${l.says}`, INNER)),
    ...[...v.reasons, ...v.unknowns].flatMap((r) => wrap(`  - ${r}`, INNER)),
  ];
}

const STEPS: readonly { key: keyof DestinationInput; label: string; placeholder?: string; mask?: true }[] = [
  { key: "endpoint", label: "Endpoint, an http(s) URL", placeholder: "https://s3.example.com" },
  { key: "bucket", label: "Bucket" },
  { key: "region", label: "Region (optional)", placeholder: "us-east-1" },
  { key: "accessKey", label: "Access key (sealed, never shown)", mask: true },
  { key: "secretKey", label: "Secret key (sealed, never shown)", mask: true },
];

const BLANK: DestinationInput = { endpoint: "", bucket: "", region: "", accessKey: "", secretKey: "" };

/** One of the two off-box places this screen sets: its prompt title and its save. */
type Target = {
  readonly title: string;
  readonly save: (input: DestinationInput) => string;
};

type Asking = "snapshot" | "mirror" | "drill";

const QUESTION: Record<Asking, string> = {
  snapshot: "take a snapshot now? y/n",
  mirror: "bring the mirror level now? y/n",
  drill: "run a restore drill now? y/n",
};

const RUNNING: Record<Asking, string> = {
  snapshot: "Taking a snapshot…",
  mirror: "Bringing the mirror level…",
  drill: "Running a restore drill…",
};

const KEY: ReadonlyMap<string, Asking> = new Map([
  ["n", "snapshot"],
  ["l", "mirror"],
  ["r", "drill"],
]);

export function resilienceScreen(f: Session, ctx: Ctx): Screen {
  // One rule for the destination and the mirror: a site admin who is a person.
  const mayChange = (): boolean => mayChangeDestination(f.user);
  const refusedAll = "Where snapshots go is a forge admin's.";
  // The actions refuse anyone else too; the keys are not offered to them.
  const mayAct = (): boolean => f.user?.isAdmin === true;
  /** The newest snapshots, `unreadable` when the store could not be listed; undefined until read. */
  let snapshots: string[] | "unreadable" | undefined;
  let asking: Asking | undefined;
  // While an action runs, `n`, `l` and `r` are ignored: a second would queue behind it.
  let busy = false;
  let said = "";
  let note = "";

  const say = (text: string): void => {
    note = text;
    ctx.invalidate();
  };

  const read = async (): Promise<void> => {
    const listed = await recentSnapshots(f.app, f.user, SNAPSHOTS);
    snapshots = listed.ok ? listed.value : "unreadable";
    ctx.invalidate();
  };

  const act = (what: Asking): void => {
    busy = true;
    said = RUNNING[what];
    ctx.invalidate();
    runAsync(ctx, async () => {
      try {
        if (what === "snapshot") {
          const taken = await snapshotNow(f.app, f.user);
          said = taken.ok ? taken.value.says : taken.error.says;
        } else if (what === "drill") {
          const ran = await drillNow(f.app, f.user);
          said = ran.ok ? ran.value.says : ran.error.says;
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

  const destination: Target = {
    title: "Snapshot destination",
    save: (input) => {
      const saved = saveDestination(f.app, f.user, input);
      return saved.ok ? saved.value : saved.error === "not_found" ? refusedAll : saved.error;
    },
  };
  const mirror: Target = {
    title: "Mirror",
    save: (input) => {
      const saved = saveMirror(f.app, f.user, input);
      return saved.ok ? saved.value : saved.error === "not_found" ? refusedAll : saved.error;
    },
  };

  /** One prompt per field, each validated as typed; the last one seals them all. */
  const step = (target: Target, i: number, given: DestinationInput): Screen => {
    const s = STEPS[i]!;
    return promptScreen(ctx, screen, {
      title: `${target.title} ${i + 1}/${STEPS.length}`,
      label: s.label,
      hint: "Blank keeps it; a refusal is said whole behind.",
      ...(s.placeholder === undefined ? {} : { placeholder: s.placeholder }),
      ...(s.mask ? { mask: true } : {}),
      onSubmit: (value) => {
        const refused = invalidField({ ...BLANK, [s.key]: value });
        // The prompt has room for the start of it; the screen behind says it whole.
        if (refused) {
          say(refused);
          return refused;
        }
        const next = { ...given, [s.key]: value };
        if (i + 1 < STEPS.length) return later(ctx, () => step(target, i + 1, next));
        say(target.save(next));
        return undefined;
      },
    });
  };

  const forgetDest = (): Screen =>
    confirmScreen(ctx, screen, {
      title: "Forget the destination?",
      body: ["The sealed endpoint, bucket and keys are cleared;", "the environment's destination, if any, takes over."],
      actions: [{ label: "Cancel", variant: "ghost" }, { label: "Forget", variant: "danger" }],
      onChoose: (index) => {
        if (index !== 1) return;
        say(forgetDestination(f.app, f.user).ok ? "The sealed destination is cleared." : refusedAll);
      },
    });

  const forgetMir = (): Screen =>
    confirmScreen(ctx, screen, {
      title: "Forget the mirror?",
      body: ["The sealed mirror settings are cleared;", "snapshots stay only on this machine."],
      actions: [{ label: "Cancel", variant: "ghost" }, { label: "Forget", variant: "danger" }],
      onChoose: (index) => {
        if (index !== 1) return;
        say(forgetMirror(f.app, f.user).ok ? "The sealed mirror is cleared." : refusedAll);
      },
    });

  // All fields blank: the destination in effect is tried, and the sentence never carries a key.
  let testing = false;
  const test = async (): Promise<void> => {
    if (testing) return;
    testing = true;
    say("Testing where snapshots go…");
    try {
      const tried = await ctx.track(testDestination(f.app, f.user, BLANK));
      say(tried.ok ? tried.value : refusedAll);
    } catch {
      say("The test failed before it could say why.");
    } finally {
      testing = false;
    }
  };

  const body = (): string[] => {
    // The question and the answer come first: a long list must not clip them.
    const out: string[] = [];
    if (asking !== undefined) out.push(QUESTION[asking], "");
    else if (said !== "") out.push(...wrap(said, INNER), "");
    out.push(...wrap(backupsLine(f.app).says, INNER), ...verdictLines(f), "");
    out.push(...wrap(destinationLine(f), INNER), ...wrap(mirrorLine(f), INNER));
    if (note !== "") out.push(...wrap(note, INNER));
    if (mayChange()) out.push("d sets where snapshots go, x forgets it.", "m sets the mirror, f forgets it.", "t tests where snapshots go.");
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
        ...(busy || !mayAct()
          ? []
          : [
              binding(["n"], "take a snapshot now"),
              binding(["l"], "bring the mirror level now"),
              binding(["r"], "run a restore drill"),
            ]),
        ...(mayChange()
          ? [
              binding(["d"], "set destination"),
              binding(["x"], "forget destination"),
              binding(["m"], "set the mirror"),
              binding(["f"], "forget the mirror"),
              binding(["t"], "test where snapshots go"),
            ]
          : []),
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
      const ask = KEY.get(e.key);
      if (ask !== undefined && !busy && mayAct()) {
        asking = ask;
        said = "";
      } else if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      else if (!mayChange()) return true;
      else if (e.key === "d") ctx.push(step(destination, 0, BLANK));
      else if (e.key === "x") ctx.push(forgetDest());
      else if (e.key === "m") ctx.push(step(mirror, 0, BLANK));
      else if (e.key === "f") ctx.push(forgetMir());
      else if (e.key === "t") void test();
      return true;
    },
  };
  return screen;
}

/** Where snapshots go and each THREATS.md protection's standing, as /resilience says it: a site admin's; a person admin sets or forgets the destination and the mirror here. */
export const entry: PaletteEntry = {
  id: "resilience",
  title: "Resilience",
  hint: "where snapshots go and the mirror; each protection green, red or untested",
  after: ["capacity", "flow", "system-memory", "sentinel"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(resilienceScreen(session, ctx)),
};
