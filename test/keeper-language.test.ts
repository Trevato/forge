/**
 * The Release keeper on /releases speaks the home page's language (#9998):
 * a plain section under an h2, no boxed card. What holds the next cut, the
 * releases table and the owner's hold forms are unchanged.
 */
import { expect, test } from "bun:test";
import { setHold } from "../src/keeper/hold.ts";
import { tick } from "../src/keeper/keeper.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { keeperForge } from "./helpers/keeper.ts";

const HEAD =
  "<thead><tr><th>Version</th><th>Cut</th><th>Landed to live</th><th>Known good</th><th>Roll non-200</th><th>Probes / pages</th><th>Worst</th><th>Stall, first 5 min</th><th>Dark</th></tr></thead>";

test("the keeper is a section with an h2, no card, with its blocked line and its table", async () => {
  const f = await keeperForge();
  await tick(f.ports);
  const out = String(keeperPanel(f.app.db));
  expect(out).toMatch(/^<section[^>]*>\s*<h2>Release keeper<\/h2>/);
  expect(out).not.toContain('class="card');
  expect(out).toContain('id="keeper-blocked"');
  expect(out).toContain("Nothing holds the next cut.");
  expect(out).toContain(HEAD);
});

test("an owner's hold still shows with its same-origin Lift form, outside any card", async () => {
  const f = await keeperForge();
  const h = setHold(f.app.db, { kind: "owner", version: "", reason: "freeze for the demo", at: f.world.now });
  const out = String(keeperPanel(f.app.db, true));
  expect(out).not.toContain('class="card');
  expect(out).toContain(`<form method="post" action="/releases/hold/${h.id}/lift"`);
  expect(out).toContain('action="/releases/hold"');
  expect(out).toMatch(/id="keeper-blocked">[^<]*freeze for the demo/);
});
