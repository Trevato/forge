/**
 * The claim link as a QR beside the link: the matrix is the link's, it draws
 * only when the whole code fits, and a redraw never repeats the link.
 */
import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { qrRows } from "../src/design/qr.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { linkScreen } from "../src/tui/screens/common.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { terminalQr } from "../src/tui/ui/qr.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();
const LINK = "https://sunny-day--forge.test/claim#0123456789abcdef0123456789abcdef";

async function shown(cols: number, rows: number, qr: boolean, link = LINK) {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-qr-")), url: "https://forge.test", port: 0 });
  const terminal = headlessTerminal(cols, rows);
  const { app: tui } = createForgeApp(app, { sshUsername: "git", remoteAddress: "203.0.113.9", fingerprint: "SHA256:t", user: undefined }, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(linkScreen(tui.ctx, link, undefined, { qr }));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  app.db.close();
  return text;
}

/** The drawn QR read back off the screen: the rows under the link line. */
function drawn(text: string, link: string, rows: number): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(link));
  expect(at).toBeGreaterThanOrEqual(0);
  return lines.slice(at + 2, at + 2 + rows);
}

test("the QR is drawn exactly in the rows reserved under the link, and is the link's", async () => {
  const code = terminalQr(LINK)!;
  const want = qrRows(code);
  const text = await shown(120, 50, true);
  const got = drawn(text, LINK, want.length);
  // Whole rows, quiet zone included, all at one column: aligned, not merely present.
  const xs = want.flatMap((row, i) => (row.trim() === "" ? [] : [got[i]!.indexOf(row)]));
  expect(xs.every((x) => x > 0 && x === xs[0])).toBe(true);
  // The rows above (the blank after the link) and below it hold no modules.
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(LINK));
  expect(lines[at + 1]!.replace(/[│\s]/g, "")).toBe("");
  expect(lines[at + 2 + want.length]!.replace(/[│\s]/g, "")).toBe("");
  expect(text.split(LINK).length - 1).toBe(1);
});

test("the drawn rows follow the link passed: another link draws other rows", async () => {
  const other = "https://other-forge--forge.test/claim#fedcba9876543210fedcba9876543210";
  const a = qrRows(terminalQr(LINK)!);
  const b = qrRows(terminalQr(other)!);
  expect(a).not.toEqual(b);
  const text = await shown(120, 50, true, other);
  const got = drawn(text, other, b.length);
  b.forEach((row, i) => expect(got[i]!.includes(row)).toBe(true));
  expect(got.every((l, i) => l.includes(a[i]!))).toBe(false);
});

test("a link longer than the default dialog is shown whole, with and without the QR", async () => {
  const long = `https://a-rather-long-forge-name--forge.test/claim#${"0123456789abcdef".repeat(4)}`;
  expect([...long].length).toBeGreaterThan(54);
  for (const qr of [true, false]) expect(await shown(160, 50, qr, long)).toContain(long);
});

test("a narrow or short terminal shows the link and no QR", async () => {
  const code = terminalQr(LINK)!;
  const rows = qrRows(code).filter((r) => r.trim() !== "");
  for (const [c, r] of [[40, 50], [120, 12]] as const) {
    const text = await shown(c, r, true);
    expect(text).toContain("Link");
    for (const row of rows) expect(text).not.toContain(row.trimEnd());
  }
});

test("without the option there is no QR", async () => {
  const code = terminalQr(LINK)!;
  const text = await shown(120, 50, false);
  expect(text).not.toContain(qrRows(code).filter((r) => r.trim() !== "")[0]!.trimEnd());
});
