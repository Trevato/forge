/**
 * Conflict blocks, read and chosen. Pure: the text of a file as
 * `git merge-tree --write-tree` leaves it (conflict markers in `diff3` style,
 * so each block carries its base) goes in; blocks come out, and a list of
 * choices turns them back into the merged file. Nothing here touches git.
 */

export type Part =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "block";
      /** The common ancestor's lines; empty when the file was not diff3. */
      readonly base: string;
      /** The base branch's side. */
      readonly ours: string;
      /** The pull branch's side. */
      readonly theirs: string;
    };

export interface Block {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

export type Choice =
  | { readonly kind: "ours" }
  | { readonly kind: "theirs" }
  | { readonly kind: "both" }
  | { readonly kind: "text"; readonly text: string };

export interface Conflicted {
  readonly parts: readonly Part[];
  readonly blocks: readonly Block[];
}

export interface Labels {
  readonly ours: string;
  readonly theirs: string;
}

const lines = (text: string): string[] => text.split(/(?<=\n)/);

/** Cut a conflicted file into plain text and conflict blocks. */
export function parseConflicts(text: string): Conflicted {
  const parts: Part[] = [];
  const blocks: Block[] = [];
  let plain = "";
  let state: "text" | "ours" | "base" | "theirs" = "text";
  let ours = "";
  let base = "";
  let theirs = "";
  let raw = ""; // the block as written, to give back if it never closes
  for (const line of lines(text)) {
    const bare = line.replace(/\r?\n$/, "");
    if (state === "text") {
      if (/^<{7}( |$)/.test(bare)) {
        state = "ours";
        raw = line;
        ours = base = theirs = "";
      } else plain += line;
      continue;
    }
    raw += line;
    if (state === "ours" && /^\|{7}( |$)/.test(bare)) state = "base";
    else if ((state === "ours" || state === "base") && /^={7}$/.test(bare))
      state = "theirs";
    else if (state === "theirs" && /^>{7}( |$)/.test(bare)) {
      if (plain !== "") parts.push({ kind: "text", text: plain });
      plain = "";
      const block = { base, ours, theirs };
      parts.push({ kind: "block", ...block });
      blocks.push(block);
      state = "text";
    } else if (state === "ours") ours += line;
    else if (state === "base") base += line;
    else theirs += line;
  }
  // An unclosed block is not a block: keep what was written.
  plain += state === "text" ? "" : raw;
  if (plain !== "") parts.push({ kind: "text", text: plain });
  return { parts, blocks };
}

/**
 * The file with each block settled by its choice. A block with no choice
 * (`undefined`) is written back as conflict markers, named by `labels`, so
 * the merged file shows what is still open. Text is kept verbatim.
 */
export function applyChoices(
  conflicted: Conflicted,
  choices: readonly (Choice | undefined)[],
  labels: Labels,
): string {
  let out = "";
  let at = 0;
  for (const part of conflicted.parts) {
    if (part.kind === "text") {
      out += part.text;
      continue;
    }
    const choice = choices[at++];
    if (choice === undefined) out += markers(part, labels);
    else if (choice.kind === "ours") out += part.ours;
    else if (choice.kind === "theirs") out += part.theirs;
    else if (choice.kind === "both") out += part.ours + part.theirs;
    else out += choice.text;
  }
  return out;
}

function markers(block: Block, labels: Labels): string {
  const nl = (s: string): string => (s === "" || s.endsWith("\n") ? s : s + "\n");
  return (
    `<<<<<<< ${labels.ours}\n${nl(block.ours)}` +
    `=======\n${nl(block.theirs)}>>>>>>> ${labels.theirs}\n`
  );
}

/** How many of the choices settle a block. */
export function resolvedCount(
  choices: readonly (Choice | undefined)[],
  total: number,
): number {
  let n = 0;
  for (let i = 0; i < total; i++) if (choices[i] !== undefined) n++;
  return n;
}
