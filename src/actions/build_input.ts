/**
 * What a talk build accepts at its boundary, once, for both doors (the API in
 * `http/api/conversation_build.ts` and MCP `say`): each check answers the
 * sentence that refuses the input, or undefined when it is fine.
 */

import { WORDS_MAX } from "../core/fence.ts";

export const BUILD_ID = /^[0-9a-z]{1,40}$/;
export const BUILD_TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** `field` names the argument in the sentence: `prompt` for the API, `text` for MCP. */
export const promptRefusal = (prompt: unknown, field = "prompt"): string | undefined =>
  typeof prompt !== "string" || prompt.trim() === "" || prompt.length > WORDS_MAX ? `${field} is a string of 1 to ${WORDS_MAX} characters` : undefined;

export const templateRefusal = (template: unknown): string | undefined =>
  template === undefined || (typeof template === "string" && BUILD_TEMPLATE.test(template)) ? undefined : "template is owner/name";

export const versionRefusal = (n: unknown): string | undefined =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 ? undefined : "version is the number of a version, from 1";
