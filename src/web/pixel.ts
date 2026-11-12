/**
 * The forge's own pixel art (#10570): a face for each of the crew and one
 * small scene, drawn here as a grid of characters, nothing fetched, nothing
 * credited. Every pixel is a rectangle painted from a theme token, so the
 * art follows all six themes and costs no colour of its own.
 *
 * Like the icons, the drawings are `<symbol>`s in the one hashed sprite
 * (`icons.ts` appends `pixelSymbols()`), so a page carries a short `<svg>`
 * and a `<use>` however many faces it shows. A fragment expands them in
 * place (`pixelInline()`), the same pixels.
 *
 * A face has two frames over one base: standing and at work (the tool moves).
 * The work frame is drawn on top of the base by patching pixels, so it costs
 * a few rectangles. Movement is CSS only
 * (`style/components.ts`, `.px`): `steps()` between frames on the shared
 * `--beat`, only for `data-state="working"`, once for `landed`, none under
 * `prefers-reduced-motion`; a hidden tab does not paint, so it does not run.
 */

import { html, raw, type Html } from "./html.ts";

/** The crew with a face: the accounts' names, which are reserved (`core/reserved.ts`). */
export const CREW_FACES = ["scout", "mason", "torque", "juniper", "sentinel"] as const;
export type CrewFace = (typeof CREW_FACES)[number];

/** What a face is doing: nothing known, building, or having just landed something. */
export type FaceState = "still" | "working" | "landed";

/**
 * One character, one fill. Only the neutral tokens: a figure is told apart by
 * its shape, never by a colour of its own, so a page keeps its one accent for
 * what can be clicked (docs/DESIGN.md, principles 4 and 5). `.` is clear.
 */
const INK: Record<string, string> = {
  o: "var(--fg)",
  k: "color-mix(in srgb,var(--muted-fg) 40%,var(--card))",
  g: "var(--muted-fg)",
  c: "var(--card)",
};

const SIZE = 16;

/** The head and shoulders every face starts from: `H` hat, `B` body, `k` skin. */
const BASE = [
  "................",
  ".....oooooo.....",
  "....oHHHHHHo....",
  "...oHHHHHHHHo...",
  "...oHHHHHHHHo...",
  "...okkkkkkkko...",
  "...okokkkkoko...",
  "...okkkkkkkko...",
  "...okkkoookko...",
  "....okkkkkko....",
  ".....oooooo.....",
  "...ooBBBBBBoo...",
  "..oBBBBBBBBBBo..",
  "..oBBBBBBBBBBo..",
  "..oBBBBBBBBBBo..",
  "..oBBBBBBBBBBo..",
];

type Patch = readonly [x: number, y: number, ch: string];

interface Drawing {
  readonly hat: string;
  readonly body: string;
  /** Pixels that make this one itself, over the base. */
  readonly mark: readonly Patch[];
  /** Pixels that move while it works. */
  readonly work: readonly Patch[];
}

const DRAWINGS: Record<CrewFace, Drawing> = {
  // Scout: a cap with a brim and a spyglass held to the eye.
  scout: {
    hat: "g",
    body: "g",
    mark: [[2, 4, "o"], [1, 4, "g"], [11, 6, "o"], [12, 6, "o"], [13, 6, "o"], [13, 5, "g"]],
    work: [[14, 6, "o"], [14, 5, "g"], [15, 5, "g"]],
  },
  // Mason: a hard hat and a trowel.
  mason: {
    hat: "c",
    body: "k",
    mark: [[2, 3, "o"], [2, 4, "c"], [3, 4, "c"], [12, 4, "c"], [13, 12, "g"], [14, 12, "g"], [14, 11, "o"]],
    work: [[13, 12, "o"], [14, 12, "o"], [14, 11, "g"], [15, 10, "g"]],
  },
  // Torque: spiked hair and a wrench.
  torque: {
    hat: "o",
    body: "o",
    mark: [[5, 0, "o"], [8, 0, "o"], [10, 0, "o"], [13, 11, "g"], [13, 12, "g"], [13, 13, "g"]],
    work: [[14, 10, "g"], [15, 10, "g"], [13, 13, "o"], [15, 9, "g"]],
  },
  // Juniper: leaves for hair and a sprig.
  juniper: {
    hat: "k",
    body: "c",
    mark: [[4, 0, "k"], [5, 0, "k"], [10, 0, "k"], [11, 1, "k"], [2, 11, "o"], [1, 12, "g"], [1, 13, "g"]],
    work: [[1, 11, "g"], [0, 12, "g"], [0, 13, "g"], [1, 14, "g"]],
  },
  // Sentinel: a helmet with a visor, and a shield.
  sentinel: {
    hat: "g",
    body: "g",
    mark: [[4, 5, "o"], [5, 5, "o"], [6, 5, "o"], [7, 5, "o"], [8, 5, "o"], [9, 5, "o"], [10, 5, "o"], [11, 5, "o"], [12, 12, "c"], [13, 12, "c"], [13, 13, "c"]],
    work: [[12, 13, "o"], [13, 14, "o"], [12, 12, "k"], [13, 12, "k"]],
  },
};

function grid(face: CrewFace): string[][] {
  const d = DRAWINGS[face];
  const rows = BASE.map((r) => [...r].map((c) => (c === "H" ? d.hat : c === "B" ? d.body : c)));
  for (const [x, y, c] of d.mark) rows[y]![x] = c;
  return rows;
}

/** A grid as rectangles, one `<path>` per colour, horizontal runs merged. */
function paint(rows: readonly (readonly string[])[]): string {
  const byInk = new Map<string, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x]!;
      let n = 1;
      while (x + n < row.length && row[x + n] === c) n++;
      if (c !== "." && INK[c] !== undefined) byInk.set(c, `${byInk.get(c) ?? ""}M${x} ${y}h${n}v1h-${n}z`);
      x += n;
    }
  });
  return [...byInk].map(([c, d]) => `<path fill="${INK[c]}" d="${d}"/>`).join("");
}

function patches(list: readonly Patch[]): string {
  const rows = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => "."));
  for (const [x, y, c] of list) rows[y]![x] = c;
  return paint(rows);
}

/** A frame's drawing: the base, then (for work) the pixels that differ, over it. */
export type Frame = "still" | "work";

/** The inside of a face's frame, no wrapper. */
export function faceContent(face: CrewFace, frame: Frame): string {
  const base = paint(grid(face));
  if (frame === "still") return base;
  return base + patches(DRAWINGS[face].work);
}

const FRAME_ID: Record<Frame, string> = { still: "", work: "work" };
const idOf = (face: CrewFace, frame: Frame): string => `pix${face}${FRAME_ID[frame]}`;

// ---- the one scene ----

const SCENE_W = 24;
const SCENE_H = 12;
/** Nothing here yet: a cold anvil on a block, one ember waiting. */
const ANVIL = [
  "........................",
  "........................",
  "........................",
  "..........o.............",
  "...ooooooooooooooo......",
  "..ogggggggggggggggo.....",
  "...oooogggggggoooo......",
  ".......oggggggo.........",
  ".......oggggggo.........",
  "......oooooooooo........",
  ".....occccccccccco......",
  ".....oooooooooooo.......",
].map((r) => [...r]);

/** Scenes by name. */
export type SceneName = "anvil";
const SCENES: Record<SceneName, readonly (readonly string[])[]> = { anvil: ANVIL };

// ---- the sprite ----

const VIEW = `viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges"`;

/** Every pixel symbol, for the sprite file (`icons.ts`). */
export function pixelSymbols(): string {
  const out: string[] = [];
  for (const face of CREW_FACES) {
    out.push(`<symbol id="i-${idOf(face, "still")}" ${VIEW}>${faceContent(face, "still")}</symbol>`);
    out.push(
      `<symbol id="i-${idOf(face, "work")}" ${VIEW}><use href="#i-${idOf(face, "still")}"/>${patches(DRAWINGS[face].work)}</symbol>`,
    );
  }
  for (const [name, rows] of Object.entries(SCENES))
    out.push(`<symbol id="i-pixscene${name}" viewBox="0 0 ${SCENE_W} ${SCENE_H}" shape-rendering="crispEdges">${paint(rows)}</symbol>`);
  return out.join("");
}

/** A `<use>` reference to a pixel symbol, as `icons.ts` reads them back. */
const ref = (id: string): string => `<use href="#i-${id}"/>`;

/**
 * The reference name → the drawing it stands for, as a nested `<svg>` for a
 * fragment (`icons.ts` `inlineIcons`). Undefined for a name that is not pixel art.
 */
export function pixelInline(id: string): string | undefined {
  for (const face of CREW_FACES)
    for (const frame of ["still", "work"] as const)
      if (idOf(face, frame) === id) return `<svg ${VIEW}>${faceContent(face, frame)}</svg>`;
  const scene = /^pixscene([a-z]+)$/.exec(id)?.[1];
  if (scene !== undefined && scene in SCENES)
    return `<svg viewBox="0 0 ${SCENE_W} ${SCENE_H}" shape-rendering="crispEdges">${paint(SCENES[scene as SceneName])}</svg>`;
  return undefined;
}

export function isCrewFace(name: string): name is CrewFace {
  return (CREW_FACES as readonly string[]).includes(name);
}

/**
 * A crew member's face, 24px, or nothing for a name with no portrait.
 * `state` is what is known to be true: a face works only when a run is, and
 * with nothing known it just stands. A face beside the name written out is
 * `decorative` (hidden from a screen reader, which would say the name twice);
 * on its own it is an image labelled with the name and, when working, the fact.
 */
export function crewFace(name: string, state: FaceState = "still", size: 16 | 24 | 48 = 24, decorative = false): Html | null {
  if (!isCrewFace(name)) return null;
  const label = state === "working" ? `${name} is working` : name;
  const layers =
    state === "working"
      ? `<g class="px-a">${ref(idOf(name, "still"))}</g><g class="px-b">${ref(idOf(name, "work"))}</g>`
      : ref(idOf(name, "still"));
  const alt = decorative ? html`aria-hidden="true"` : html`role="img" aria-label="${label}"`;
  return html`<svg class="px" data-state="${state}" width="${String(size)}" height="${String(size)}" ${alt} focusable="false"
    >${raw(layers)}</svg
  >`;
}

/** The scene for an empty page, 48×24, decorative: the line beside it says the thing. */
export function scene(name: SceneName): Html {
  return html`<svg class="px px-scene" width="${String(SCENE_W * 2)}" height="${String(SCENE_H * 2)}" aria-hidden="true" focusable="false">${raw(ref(`pixscene${name}`))}</svg>`;
}

/**
 * A face placed inside a larger drawing (the map's cards), still: an animation
 * inside a big inline SVG repaints all of it, so the map's faces never move
 * and the card's own ring says who is working.
 */
export function faceAt(name: string, x: number, y: number, size: number): Html | null {
  if (!isCrewFace(name)) return null;
  return html`<svg class="px" x="${String(x)}" y="${String(y)}" width="${String(size)}" height="${String(size)}" aria-hidden="true" focusable="false">${raw(ref(idOf(name, "still")))}</svg>`;
}
