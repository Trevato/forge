/**
 * The app template's files, as a new app gets them (`templates/app-template.json`),
 * written to a directory so the forge's tests can import and run the very text it
 * hands out (#11596: the job runtime and its own tests live in the template).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const bundle = JSON.parse(readFileSync(new URL("../../templates/app-template.json", import.meta.url), "utf8")) as { files: Record<string, string> };

/** The template written under a fresh directory; the path of that directory. */
export function writeTemplate(): string {
  const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "forge-tpl-"));
  for (const [path, body] of Object.entries(bundle.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

export const TEMPLATE_DIR = writeTemplate();
