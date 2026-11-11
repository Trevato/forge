/**
 * The first page of a freshly claimed forge, in plain words (#10752): what
 * sits in `<main>` for the owner, and for the everyday account the owner
 * makes next, holds none of the words in `helpers/jargon.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { claimedForge, type ClaimedForge } from "./helpers/claimed-forge.ts";
import { jargonIn } from "./helpers/jargon.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

describe("the first-login page of a spawned forge, in plain words", () => {
  let forge: ClaimedForge;
  let owner = "";
  const url = (path: string) => `${forge.base}${path}`;

  beforeAll(async () => {
    forge = await claimedForge("forge-first-login-words-");
    owner = forge.owner;
  }, 60_000);

  afterAll(() => forge.stop());

  /** The page itself, to check the first-login content is what was read. */
  const mainOf = (html: string) => /<main\b[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";

  test("the owner's first page has no jargon", async () => {
    const html = await (await fetch(url("/"), { headers: { cookie: owner } })).text();
    expect(mainOf(html)).toContain("What do you want built?");
    expect(jargonIn(html)).toEqual([]);
  });

  test("the everyday account's first page has no jargon", async () => {
    const who = { username: "maria-me", email: "me@bakery.test" };
    const res = await forge.post(owner, "/settings/everyday", {
      ...who,
      ...(await passkeyFields(forge.base, "/settings/everyday/options", who, { headers: { cookie: owner } })),
    });
    expect(res.status).toBe(303);
    const daily = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const html = await (await fetch(url("/"), { headers: { cookie: daily } })).text();
    expect(mainOf(html)).toContain("What do you want built?");
    expect(jargonIn(html)).toEqual([]);
  });

  test("after the first tell, the steps card has no jargon either", async () => {
    const told = await forge.post(owner, "/marias/bakery/tell", { text: "Add a weekly menu page." });
    expect(told.status).toBeLessThan(400);
    const html = await (await fetch(url("/"), { headers: { cookie: owner } })).text();
    expect(mainOf(html)).toContain("Your next steps");
    expect(jargonIn(html)).toEqual([]);
  });

  test("the word list sees the words it is for", () => {
    expect(jargonIn('<p>Add an SSH key</p><a title="Open the palette">x</a>')).toHaveLength(2);
    expect(jargonIn("<p>Your cellar, a gated community</p>")).toEqual([]);
    expect(jargonIn("<p>an ssh-key and a model-key</p>")).toHaveLength(2);
  });
});
