// Every destructive button asks first. A `btn(..., { variant: "danger" })`
// inside a plain `<form method="post">` deletes on one click; new ones should
// go through `confirmAction` from src/web/ui.ts, which links to /-/confirm.
// The scan is plain text, kept narrow so it never fails on correct code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const web = join(root, "src", "web");

/** Today's danger POST buttons that do not ask first, one `file — reason` per line. */
const allowed: readonly { file: string; button: string; reason: string }[] = [
  { file: "src/web/pages/edit.ts", button: `"Delete this file"`, reason: "the delete page is the confirmation, reached by a link" },
  { file: "src/web/pages/pull.ts", button: `"Land past the gate"`, reason: "asks for a typed reason of at least 8 characters" },
  { file: "src/web/studio/change.ts", button: `"Send it back"`, reason: "a changes-requested verdict; the next review replaces it" },
  { file: "src/web/studio/notes.ts", button: "label", reason: "owner note ban; undone by unban on the same row" },
  { file: "src/web/studio/change.ts", button: `"Send it back"`, reason: "a changes-requested review with an optional why; the next review replaces it" },
];

type DangerPost = { file: string; line: number; button: string };

/** The index of the paren closing the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Danger buttons that post straight from a form with no confirm field. */
function dangerPosts(file: string, text: string): DangerPost[] {
  const found: DangerPost[] = [];
  for (const m of text.matchAll(/variant:\s*"danger"/g)) {
    const at = m.index;
    // The btn( call holding this option, close enough to be the same call.
    const call = Math.max(text.lastIndexOf("btn(", at), text.lastIndexOf("iconBtn(", at));
    if (call < 0 || at - call > 400) continue;
    const open = text.indexOf("(", call);
    const end = closing(text, open);
    if (end < at) continue;
    const args = text.slice(open + 1, end);
    if (/\bhref:/.test(args)) continue; // a link, as confirmAction makes
    // The enclosing form: the last <form before the button, not yet closed.
    const form = text.lastIndexOf("<form", at);
    if (form < 0 || text.slice(form, at).includes("</form")) continue;
    const tag = text.slice(form, text.indexOf(">", form) + 1);
    if (!/method="post"/i.test(tag)) continue;
    const close = text.indexOf("</form", at);
    const body = text.slice(form, close < 0 ? text.length : close);
    if (/name(=|:\s*)"confirm"/.test(body)) continue; // the form is the confirmation
    const button = args.slice(0, args.search(/,|$/)).trim();
    const line = text.slice(0, at).split("\n").length;
    found.push({ file, line, button });
  }
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

describe("danger buttons", () => {
  test("a new danger button inside a post form is found", () => {
    const page = 'html`<form method="post" action="/x">${btn("Wipe", { variant: "danger" })}</form>`';
    expect(dangerPosts("x.ts", page)).toEqual([{ file: "x.ts", line: 1, button: `"Wipe"` }]);
  });

  test("links, confirm pages and get forms are not", () => {
    const cases = [
      'html`<form method="post" action="/x">${btn("Wipe", { href: "/-/confirm?to=/x", variant: "danger" })}</form>`',
      'html`<form method="post" action="/x"><input name="confirm" />${btn("Wipe", { variant: "danger" })}</form>`',
      'html`<form method="post" action="/x">${formField({ name: "confirm" })}${btn("Wipe", { variant: "danger" })}</form>`',
      'html`<form method="get" action="/x">${btn("Wipe", { variant: "danger" })}</form>`',
      'html`<form method="post" action="/x"></form>${btn("Wipe", { variant: "danger" })}`',
      'const tone = { variant: "danger" };',
    ];
    for (const page of cases) expect(dangerPosts("x.ts", page)).toEqual([]);
  });

  test("every danger button in src/web asks first or is on the list", () => {
    const found = sources(web).flatMap((path) =>
      dangerPosts(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")),
    );
    const listed = (d: { file: string; button: string }) =>
      allowed.some((a) => a.file === d.file && a.button === d.button);
    const stale = allowed.filter((a) => !found.some((d) => d.file === a.file && d.button === a.button));
    if (stale.length > 0)
      console.log(
        `danger-buttons: these listed cases are gone; drop them from the list:\n${stale
          .map((a) => `  ${a.file} ${a.button} — ${a.reason}`)
          .join("\n")}`,
      );
    const unasked = found
      .filter((d) => !listed(d))
      .map((d) => `${d.file}:${d.line} ${d.button} posts without asking: use confirmAction from src/web/ui.ts`);
    expect(unasked).toEqual([]);
  });
});
