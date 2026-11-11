/**
 * The first-login card (VISION §4, `web/pages/next-steps.ts`): three steps in
 * order, each reachable by the admin it is drawn for, the everyday step
 * reading done once the account exists, and never shown to a guest or to a
 * second account.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSession } from "../src/core/sessions.ts";
import { nextStepsFor } from "../src/core/next-steps.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { claimedForge, PASSWORD, type ClaimedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const CARD = "Your next steps";

describe("the next-steps card of a spawned forge", () => {
  let forge: ClaimedForge;
  let owner = "";

  const url = (path: string) => `${forge.base}${path}`;
  const page = async (cookie: string, path = "/") =>
    (await (await fetch(url(path), { headers: { cookie } })).text()).replace(
      /\s+/g,
      " ",
    );
  const post = (cookie: string, path: string, form: Record<string, string>) =>
    forge.post(cookie, path, form);
  const steps = (html: string) => {
    const card = html.slice(html.indexOf(CARD));
    return {
      everyday: /data-step="everyday"[^>]*data-done="(yes|no)"/.exec(card)?.[1],
      apps: /data-step="apps"[^>]*data-done="(yes|no)"/.exec(card)?.[1],
      tell: /data-step="tell"[^>]*data-done="(yes|no)"/.exec(card)?.[1],
    };
  };

  beforeAll(async () => {
    forge = await claimedForge("forge-next-steps-card-");
    owner = forge.owner;
  }, 60_000);

  afterAll(() => forge.stop());

  const cardOf = (html: string) => {
    const from = html.indexOf(`id="next-steps"`);
    return from < 0 ? "" : html.slice(from, html.indexOf("</section>", from) < 0 ? undefined : html.indexOf("</section>", from));
  };
  const keys = (html: string) =>
    [...cardOf(html).matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);

  test("the first screen leads with the tell box; the passkey form is not shown before it", async () => {
    const home = await page(owner);
    const main = home.slice(home.indexOf("<main"), home.indexOf("</main>"));
    const forms = [...main.matchAll(/<form[^>]*>/g)].map((m) => m[0]);
    expect(forms[0]).toContain('id="composer"');
    expect(forms[0]).toContain('action="/tell"');
    expect(forms.filter((f) => f.includes('action="/tell"')).length).toBe(1);
    expect(main).not.toContain("/settings/everyday");
    expect(main).not.toContain("There is no password");
    expect(main.match(/data-variant="primary"/g)?.length).toBe(1);
    expect(keys(home)).toEqual([]);
  });

  test("the first screen is one form whatever the crew runs on: a line, and for an admin a link, never the key field", async () => {
    const file = join(forge.child.config.dataDir, "parent.json");
    const before = readFileSync(file, "utf8");
    const lines: Record<string, string> = {
      "": "The crew needs a model key to start.",
      credit: "included credit.",
    };
    try {
      for (const [mode, said] of Object.entries(lines)) {
        const doc = JSON.parse(before);
        if (mode === "") delete doc.credit;
        writeFileSync(file, JSON.stringify(doc));
        const home = await page(owner);
        const main = home.slice(home.indexOf("<main"), home.indexOf("</main>"));
        expect(main).toContain(said);
        expect(main).toContain('href="/settings/subscriptions"');
        expect(main).not.toContain('action="/settings/crew/key"');
        expect(main).not.toContain('type="password"');
        expect([...main.matchAll(/<form[^>]*>/g)].length).toBe(1);
        expect(main.match(/data-variant="primary"/g)?.length).toBe(1);
      }
    } finally {
      writeFileSync(file, before);
    }
  });

  test("the tell box sends a tell, and the everyday offer appears once one exists", async () => {
    const told = await post(owner, "/marias/bakery/tell", { text: "Add a weekly menu page." });
    expect(told.status).toBeLessThan(400);
    const home = await page(owner);
    const main = home.slice(home.indexOf("<main"), home.indexOf("</main>"));
    expect(main).toContain('action="/settings/everyday"');
    expect(main).toContain("There is no password");
  });

  test("the admin's first home carries exactly three steps, in order, none done", async () => {
    const home = await page(owner);
    expect(keys(home)).toEqual(["everyday", "apps", "tell"]);
    expect(steps(home)).toEqual({ everyday: "no", apps: "no", tell: "yes" });
    const titles = ["Make your everyday account", "Open your apps", "Tell the crew something"];
    const at = titles.map((t) => cardOf(home).indexOf(t));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("the steps are one plain section, not boxed in cards", async () => {
    const card = cardOf(await page(owner));
    expect(card).not.toContain('class="card');
    expect(card).not.toContain("card-body");
    // A pending step's body is a block under its row, never an inline sibling of the title.
    expect(card).toMatch(/<\/ul>\s*<div class="step-body">/);
    // The first pending step, and only it, is the primary one.
    expect(card).toMatch(/data-step="everyday"[^>]*data-primary/);
    expect(card.match(/data-primary/g)?.length).toBe(1);
    expect(keys(await page(owner))).toEqual(["everyday", "apps", "tell"]);
  });

  test("each step's way in answers 200 for the admin", async () => {
    const home = await page(owner);
    const card = cardOf(home);
    // Open your apps: the app links in the card.
    const apps = [...card.matchAll(/href="(\/[^"#]+)"/g)].map((m) => m[1]!).filter((h) => h.startsWith("/marias/"));
    expect(apps).toContain("/marias/bakery");
    // Tell the crew: the card points at the composer, which must be on the page.
    expect(home).toContain('id="composer"');
    // Make your everyday account: the form lives in the card, which posts to a route only (no GET page); settings answers.
    expect(card).toContain('action="/settings/everyday"');
    const paths = [...new Set([...apps, "/settings"])];
    for (const p of paths) {
      const res = await fetch(url(p), { headers: { cookie: owner }, redirect: "manual" });
      expect([p, res.status]).toEqual([p, 200]);
    }
  });

  test("a guest never sees the card", async () => {
    const res = await fetch(url("/"), { redirect: "manual" });
    expect(res.status).toBeLessThan(400);
    expect(await res.text()).not.toContain(CARD);
  });

  test("a second account never sees the card", async () => {
    const other = await createUser(forge.child.db, {
      origin: "seed",
      trusted: true,
      username: "second",
      email: "second@x.test",
      password: PASSWORD,
    });
    if (!other.ok) throw new Error("second");
    const session = createSession(forge.child.db, other.value.id);
    const home = await page(`forge_session=${session.token}`);
    expect(home).not.toContain(CARD);
    expect(home).not.toContain('data-step="');
  });

  test("once the everyday account exists, its step reads done", async () => {
    const who = { username: "maria-me", email: "me@bakery.test" };
    const res = await post(owner, "/settings/everyday", {
      ...who,
      ...(await passkeyFields(forge.base, "/settings/everyday/options", who, { headers: { cookie: owner } })),
    });
    expect(res.status).toBe(303);
    const daily = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    // The earlier tests told the crew and opened an app: with the account made, every step is done and the card is gone.
    const user = getUserByName(forge.child.db, "maria")!;
    expect((await nextStepsFor(forge.child, user))?.map((x) => x.done)).toEqual([true, true, true]);
    expect(await page(owner)).not.toContain(CARD);
    expect(await page(daily)).not.toContain(CARD);
  });
});
