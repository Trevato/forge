/**
 * Where a tell came from. A tell said inside an app or a harness carries
 * the page it was said on, the run and commit that were current, and the
 * person's own words, so the agent that picks it up sees its context. Each
 * field is checked at the boundary and bounded; what passes is appended to
 * the tell as a plain block the issue shows and the agent reads.
 */

export interface TellContext {
  readonly page?: string;
  readonly run?: string;
  readonly commit?: string;
  readonly said?: string;
}

const SAID_MAX = 2000;
const RUN = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

/** The checked context, nothing for none, or null when a field is malformed. */
export function parseContext(v: unknown): TellContext | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: { page?: string; run?: string; commit?: string; said?: string } = {};
  if (o["page"] !== undefined) {
    const url =
      typeof o["page"] === "string" && o["page"].length <= 2000
        ? URL.parse(o["page"])
        : null;
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:"))
      return null;
    out.page = url.href;
  }
  if (o["run"] !== undefined) {
    if (typeof o["run"] !== "string" || !RUN.test(o["run"])) return null;
    out.run = o["run"];
  }
  if (o["commit"] !== undefined) {
    if (typeof o["commit"] !== "string" || !COMMIT.test(o["commit"])) return null;
    out.commit = o["commit"];
  }
  if (o["said"] !== undefined) {
    if (typeof o["said"] !== "string" || o["said"].length > SAID_MAX) return null;
    out.said = o["said"].trim();
  }
  return out;
}

/** The block appended to a tell; empty when there is nothing to say. */
export function contextNote(c: TellContext | undefined): string {
  if (c === undefined) return "";
  const lines = [
    c.page === undefined ? "" : `- page: ${c.page}`,
    c.run === undefined ? "" : `- run: ${c.run}`,
    c.commit === undefined ? "" : `- commit: ${c.commit}`,
    c.said === undefined || c.said === ""
      ? ""
      : `- their words: ${c.said.replace(/\s*\n\s*/g, " ")}`,
  ].filter((l) => l !== "");
  return lines.length === 0 ? "" : `\n\n---\nWhere this was told from:\n${lines.join("\n")}`;
}
