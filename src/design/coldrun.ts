/**
 * The cold-read loop with its three outside things injected: fetching a page,
 * shooting it, asking the model. `scripts/cold-read.ts` passes the real ones;
 * the test passes stubs.
 */
import { MAX_WORDS, WIDTHS, answerWords, parseAnswer, refusal, scorePage, type PageScore, type Reading } from "./coldread.ts";

export interface Shot {
  /** "image" when Chromium shot it, "text" when only the page's text is sent. */
  readonly kind: "image" | "text";
  readonly block: unknown;
}

export interface Deps {
  fetchPage(path: string): Promise<{ status: number; location: string | null; html: string }>;
  shoot(html: string, path: string, w: { width: number; height: number }): Promise<Shot>;
  ask(shot: unknown, prompt: string): Promise<string>;
  log(line: string): void;
}

export interface Run {
  readonly pages: Record<string, PageScore>;
  readonly findings: { page: string; device: string; text: string }[];
  /** Pages that could not be read, with why. */
  readonly failed: Record<string, string[]>;
  /** "text-only" when any reading had no screenshot: phone and desktop then saw the same words. */
  readonly mode: "screenshot" | "text-only";
}

export async function coldRead(pagePaths: readonly string[], promptTemplate: string, deps: Deps): Promise<Run> {
  const pages: Run["pages"] = {};
  const findings: Run["findings"] = [];
  const failed: Record<string, string[]> = {};
  let textOnly = false;
  for (const page of pagePaths) {
    const readings: Reading[] = [];
    for (const w of WIDTHS) {
      try {
        const res = await deps.fetchPage(page);
        const why = refusal(page, res.status, res.location);
        if (why) throw new Error(why);
        const shot = await deps.shoot(res.html, page, w);
        if (shot.kind === "text") textOnly = true;
        const prompt = promptTemplate.replace("{{width}}", String(w.width)).replace("{{device}}", w.device);
        const answer = parseAnswer(await deps.ask(shot.block, prompt));
        if (typeof answer === "string") throw new Error(answer);
        if (answerWords(answer) > MAX_WORDS) deps.log(`${page} ${w.device}: over ${MAX_WORDS} words (${answerWords(answer)}), kept`);
        readings.push({ device: w.device, answer });
        for (const c of answer.confusing) findings.push({ page, device: w.device, text: c });
        deps.log(`${page} ${w.device}: clarity ${answer.clarity}; first click: ${answer.clickFirst}`);
      } catch (e) {
        (failed[page] ??= []).push(`${w.device}: ${(e as Error).message}`);
        deps.log(`${page} ${w.device}: ${(e as Error).message}`);
      }
    }
    const s = scorePage(readings);
    if (s) pages[page] = s;
  }
  return { pages, findings, failed, mode: textOnly ? "text-only" : "screenshot" };
}
