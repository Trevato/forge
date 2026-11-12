/**
 * What a note from the forge pill says about where it came from (#10827):
 * the build the app was serving and up to five recent console errors, each
 * cut short. (The page is already the issue's `- Page:` line, so it is not
 * said twice.) Every field
 * is checked at the boundary and bounded; what passes is a fold at the foot
 * of the issue, never its headline. Console text can hold secrets, so only
 * the message is kept, and anything shaped like a credential or a URL query
 * is cut out of it. Plain data in, plain data out.
 */

export interface NoteContext {
  readonly build: string;
  readonly errors: readonly string[];
}

export const ERRORS_MAX = 5;
export const ERROR_CHARS = 200;
const BUILD = /^[0-9a-f]{7,64}$/;

/** A message with what looks like a secret or a query string taken out. */
export function scrubMessage(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\b(https?:\/\/[^\s?#]*)[?#]\S*/gi, "$1")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [removed]")
    .replace(/\b([A-Za-z_-]*(?:token|secret|key|password|passwd|auth|session|cookie)[A-Za-z_-]*)\s*[:=]\s*\S+/gi, "$1=[removed]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, "[removed]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[removed]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The context of a note: `build` is what the forge knows is serving (never
 * the client's word), `errors` what the client sent. Anything malformed is dropped,
 * never an error: the note itself still goes.
 */
export function parseNoteContext(errors: unknown, build: string | undefined): NoteContext {
  const list: string[] = [];
  if (Array.isArray(errors)) {
    for (const e of errors.slice(0, ERRORS_MAX)) {
      if (typeof e !== "string") continue;
      const m = scrubMessage(e.slice(0, 2000)).slice(0, ERROR_CHARS);
      if (m !== "") list.push(m);
    }
  }
  return { build: build !== undefined && BUILD.test(build) ? build : "", errors: list };
}

/** The fold appended to a note's issue; empty when there is nothing to say. */
export function contextFold(c: NoteContext): string {
  if (c.build === "" && c.errors.length === 0) return "";
  const lines = [
    c.build === "" ? "" : `- Build: \`${c.build}\``,
    // The sender's browser's words, unchecked: data, not instructions.
    ...c.errors.map((e) => `- Console error: \`${e.replace(/`/g, "'")}\``),
  ].filter((l) => l !== "");
  return ["", "<details><summary>Where this came from</summary>", ...lines, "</details>"].join("\n");
}
