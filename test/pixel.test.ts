/** The forge's own pixel art (#10570): faces, one scene, one motion vocabulary, nothing from outside. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { inlineIcons, spriteSvg } from "../src/web/icons.ts";
import { CREW_FACES, crewFace, faceAt, pixelSymbols, scene } from "../src/web/pixel.ts";
import { css } from "../src/web/style.ts";
import { avatar, empty } from "../src/web/ui.ts";
import { wordBadge } from "../src/web/studio/words.ts";

let dir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-pixel-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("every crew member has a face in two frames, and the scene is drawn", () => {
  const sprite = spriteSvg();
  for (const name of CREW_FACES)
    for (const suffix of ["", "work"]) expect(sprite).toContain(`id="i-pix${name}${suffix}"`);
  expect(sprite).toContain('id="i-pixsceneanvil"');
});

test("all the art together stays under the 20 KB budget", () => {
  expect(new TextEncoder().encode(pixelSymbols()).length).toBeLessThan(8_000);
  expect(new TextEncoder().encode(crewFace("mason", "working")!.text + scene("anvil").text).length).toBeLessThan(1_000);
});

test("a face works only when told a run is going", () => {
  expect(crewFace("someone")).toBeNull();
  const working = crewFace("scout", "working")!.text;
  expect(working).toContain('data-state="working"');
  expect(working).toContain("px-a");
  expect(working).toContain("px-b");
  expect(crewFace("scout")!.text).not.toContain("px-b");
  expect(sprite()).not.toContain("rest");
  expect(crewFace("juniper", "landed")!.text).toContain('data-state="landed"');
});

const sprite = (): string => spriteSvg();

test("the art is painted with fill attributes in neutral tokens, never a style attribute or an accent", () => {
  const all = [
    spriteSvg(),
    inlineIcons(avatar("mason").text),
    inlineIcons(scene("anvil").text),
    inlineIcons(crewFace("scout", "working")!.text),
  ];
  for (const markup of all) {
    expect(markup).not.toMatch(/\sstyle=/);
    expect(markup).not.toMatch(/--(?:accent|merged|success|danger)/);
  }
  expect(pixelSymbols()).toContain('fill="var(--fg)"');
});

test("a face is an image on its own and hidden where the name is written beside it", () => {
  expect(crewFace("mason", "working")!.text).toContain('aria-label="mason is working"');
  const beside = crewFace("mason", "working", 16, true)!.text;
  expect(beside).toContain('aria-hidden="true"');
  expect(beside).not.toContain("aria-label");
  expect(beside).not.toContain('role="img"');
  expect(faceAt("mason", 1, 2, 14)!.text).toContain('aria-hidden="true"');
});

test("the crew wear their face as an avatar; everyone else keeps initials", () => {
  expect(avatar("sentinel").text).toContain("i-pixsentinel");
  expect(avatar("alice").text).toContain(">a<");
  expect(wordBadge("working", "x", "mason").text).toContain("i-pixmasonwork");
  expect(wordBadge("working", "x").text).toContain("i-loader");
});

test("an empty page can show the scene in place of an icon", () => {
  const out = empty({ scene: "anvil", title: "Nothing yet" }).text;
  expect(out).toContain("i-pixsceneanvil");
  expect(out).toContain("Nothing yet");
});

test("a fragment expands the faces in place, with no reference left to the sprite", () => {
  const out = inlineIcons(avatar("mason").text);
  expect(out).not.toContain("<use");
  expect(out).toContain("<path");
});

test("motion is one vocabulary and is gated on reduced motion", () => {
  for (const token of ["--dur-1", "--dur-2", "--dur-3", "--beat"]) expect(css).toContain(`${token}:`);
  const frame = css.indexOf("@keyframes px-a");
  const gate = css.lastIndexOf("@media (prefers-reduced-motion: no-preference)", frame);
  expect(gate).toBeGreaterThan(-1);
  expect(css.slice(gate, frame)).not.toContain("}\n}");
  expect(css).not.toContain("image-rendering");
});

test("no stylesheet, sprite or page loads an image or a font from outside the forge", async () => {
  const outside = /(?:url\(\s*["']?(?:https?:)?\/\/|@import|@font-face)/i;
  expect(css).not.toMatch(outside);
  expect(spriteSvg()).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  for (const path of ["/", "/login"]) {
    const r = await fetch(`${servers.url}${path}`, { redirect: "manual" });
    const body = await r.text();
    for (const tag of body.match(/<(?:img|link|source|image)\b[^>]*>/gi) ?? []) {
      // A canonical or alternate link names a page, not something the page loads.
      if (/^<link/i.test(tag) && !/rel=["']?(?:stylesheet|[a-z-]*icon|preload|modulepreload|prefetch)/i.test(tag)) continue;
      const target = /(?:src|href|srcset)=["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? "";
      expect(target.startsWith("http") || target.startsWith("//")).toBe(false);
    }
    expect(body).not.toMatch(outside);
    const policy = r.headers.get("content-security-policy") ?? "";
    for (const directive of policy.split(";"))
      if (/^\s*(?:img|font|style)-src/.test(directive)) expect(directive).not.toMatch(/https?:/);
  }
});
