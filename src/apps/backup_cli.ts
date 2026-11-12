/**
 * An app's encrypted backup and its restore proof, as a command line: the owner runs it, and so does the terminal's door.
 *   APP_BACKUP_PASSPHRASE=… bun scripts/app-backup.ts seal <data-dir> <out-file>
 *   APP_BACKUP_PASSPHRASE=… bun scripts/app-backup.ts prove <backup-file> <empty-scratch-dir>
 * A trailing `--json` prints the proof as one JSON line in place of the
 * words (the terminal's door, src/apps/backup_door.ts, reads it).
 * `seal` proves the sealed bytes and the data directory left behind, and
 * keeps <out-file> only when the proof passed. Exit 0 only then.
 * This lives under src/ because the terminal's door (backup_door.ts) runs it as
 * a child process and the release image ships src/ alone; scripts/app-backup.ts
 * is the owner's entry to it. See docs/features/app-backup.md.
 */
import { readFileSync } from "node:fs";
import { restoreProof, sealAndProve, type Proof } from "./backup.ts";
import { proofLines } from "./backup_words.ts";

const argv = process.argv.slice(2);
const json = argv.at(-1) === "--json";
const [cmd, a, b] = json ? argv.slice(0, -1) : argv;
const pass = process.env["APP_BACKUP_PASSPHRASE"] ?? "";
const show = (p: Proof): void => {
  if (json) console.log(JSON.stringify(p));
  else for (const l of proofLines(p)) console.log(l);
};

try {
  if (cmd === "seal" && a && b) {
    const p = sealAndProve(a, b, pass);
    show(p);
    process.exit(p.ok ? 0 : 1);
  } else if (cmd === "prove" && a && b) {
    const p = restoreProof(readFileSync(a), pass, b);
    if (typeof p === "string") throw new Error(p);
    show(p);
    process.exit(p.ok ? 0 : 1);
  } else {
    console.error("usage: app-backup.ts seal <data-dir> <out-file> | prove <backup-file> <empty-scratch-dir>");
    process.exit(2);
  }
} catch (e) {
  console.error(`app-backup: ${(e as Error).message}`);
  process.exit(1);
}
