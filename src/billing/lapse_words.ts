/** The sentences a lapsed forge (billing `none`, #11393) is told in, shared by the wake page and the terminal. */

import type { Lapse } from "./lapse.ts";

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** What happened, in one sentence. */
export const lapsedSentence = (name: string): string =>
  `${name} is asleep because its subscription ended and was not paid again.`;

/** How to take the data, in a sentence that names until when it is kept. */
export const exportSentence = (lapse: Extract<Lapse, { state: "none" }>, front: string): string =>
  `Your data is kept until ${day(lapse.keepUntil)}. To take it with you, ask this forge's operator at ${front} for an export of your forge's data.`;
