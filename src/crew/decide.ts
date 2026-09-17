/**
 * Decisions the forge makes without a person: which builder takes a sentence,
 * how big it is, whether a red check is the agent's fault, which option on a
 * card is likely right. Every one has the same shape — a state in words, a
 * set of questions each with fixed choices, a probability per choice out —
 * and every one has a rule that answers it today. A decider answers them
 * better: TypeSafe's Jev, a small local model, anything with that shape. The
 * rule stays as the fallback, so a decider that is slow, down or absent
 * costs a wait of at most `DECIDE_TIMEOUT_MS` and never a wrong answer.
 *
 * Nothing here generates text. A decider only chooses among choices the
 * forge wrote down, which is what makes its answer safe to act on.
 */

import { createLog } from "../kernel/log.ts";

const log = createLog("decide");

/** How long a decision may take before the rule answers instead. */
export const DECIDE_TIMEOUT_MS = 2_500;

export interface Question {
  /** The fixed choices; the answer is always one of these. */
  readonly options: readonly string[];
  /** What the question means, for a decider that reads. */
  readonly about?: string;
  /** What each choice means, when a name alone would not say. */
  readonly describe?: Readonly<Record<string, string>>;
}

/** What a decision is about: words, or a record of named facts. */
export type State = string | Readonly<Record<string, unknown>>;

export type Questions = Readonly<Record<string, Question>>;

export interface Answer {
  readonly choice: string;
  /** Probability of `choice`, 0–1. */
  readonly p: number;
  /** Probability of every option, summing to about 1. */
  readonly probabilities: Readonly<Record<string, number>>;
}

export type Answers<Q extends Questions> = { readonly [K in keyof Q]: Answer };

export interface Decided<Q extends Questions> {
  readonly answers: Answers<Q>;
  /** Who answered: a decider's name, or `rule`. */
  readonly by: string;
  readonly ms: number;
}

export interface Decider {
  readonly name: string;
  decide<Q extends Questions>(
    state: State,
    questions: Q,
    signal: AbortSignal,
  ): Promise<Answers<Q>>;
}

/** An answer that is certain of one choice: what a rule says. */
export function certain(options: readonly string[], choice: string): Answer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === choice ? 1 : 0;
  return { choice, p: 1, probabilities };
}

/**
 * Ask the decider, or fall back to the rule. `rule` gives the answer the
 * forge would have given anyway, so the decider only ever improves on it;
 * an answer outside the options, an error, or a slow reply is the rule's.
 */
export async function decideOr<Q extends Questions>(
  decider: Decider | undefined,
  state: State,
  questions: Q,
  rule: () => Answers<Q>,
  timeoutMs = DECIDE_TIMEOUT_MS,
): Promise<Decided<Q>> {
  const started = Date.now();
  if (decider === undefined || Object.keys(questions).length === 0)
    return { answers: rule(), by: "rule", ms: 0 };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const answers = await decider.decide(state, questions, abort.signal);
    for (const key of Object.keys(questions) as (keyof Q)[]) {
      const a = answers[key];
      if (a === undefined || !questions[key]!.options.includes(a.choice))
        throw new Error(`no answer within the options for ${String(key)}`);
    }
    const ms = Date.now() - started;
    log.info("decided", {
      by: decider.name,
      ms,
      answers: Object.entries(answers)
        .map(([k, a]) => `${k}=${a.choice}@${a.p.toFixed(2)}`)
        .join(" "),
    });
    return { answers, by: decider.name, ms };
  } catch (error) {
    log.warn("decider did not answer; the rule did", {
      decider: decider.name,
      questions: Object.keys(questions).join(","),
      error: error instanceof Error ? error.message : String(error),
    });
    return { answers: rule(), by: "rule", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ---- TypeSafe: Jev ----

export interface TypeSafeOptions {
  readonly apiKey: string;
  /** The API's base URL; the default is TypeSafe's. */
  readonly url?: string | undefined;
  /** A model name from `GET /v1/models`; the default is the latest Jev. */
  readonly model?: string | undefined;
}

export const TYPESAFE_URL = "https://api.typesafe.ai";
export const TYPESAFE_MODEL = "jev-latest";

/**
 * TypeSafe's `POST /v1/systemone`: content in `state`, named questions, each
 * of type `choice` with `criteria` — the choices, and what each means —
 * and `instructions` saying what to decide. Answers come back under the
 * same names with `choice`, `confidence` and `probabilities` per choice.
 * Their contract is one place here, so a change in it is a change here.
 */
export function typeSafeRequest(
  state: State,
  questions: Questions,
  model: string | undefined,
): Record<string, unknown> {
  return {
    model: model ?? TYPESAFE_MODEL,
    state,
    questions: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        {
          type: "choice",
          ...(q.about === undefined ? {} : { instructions: q.about }),
          criteria: Object.fromEntries(
            q.options.map((o) => [o, q.describe?.[o] ?? null]),
          ),
        },
      ]),
    ),
  };
}

/**
 * Read the answers back. A choice the model names outside the options is
 * ignored; an option the model left unsaid is 0; the chosen option is the
 * most probable one over the options we asked about, whatever `choice`
 * says, so the answer is always one of ours.
 */
export function typeSafeAnswers<Q extends Questions>(
  body: unknown,
  questions: Q,
): Answers<Q> {
  const root = body as Record<string, unknown>;
  const answered =
    (root["answers"] as Record<string, unknown> | undefined) ?? root;
  const out: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const raw = answered[key] as Record<string, unknown> | undefined;
    const probabilities: Record<string, number> = {};
    for (const o of q.options) probabilities[o] = 0;
    const given =
      (raw?.["probabilities"] as Record<string, unknown> | undefined) ?? {};
    for (const [option, p] of Object.entries(given))
      if (typeof p === "number" && option in probabilities)
        probabilities[option] = p;
    let best = q.options[0]!;
    for (const o of q.options)
      if (probabilities[o]! > probabilities[best]!) best = o;
    out[key] = { choice: best, p: probabilities[best]!, probabilities };
  }
  return out as Answers<Q>;
}

export function typeSafeDecider(options: TypeSafeOptions): Decider {
  const base = (options.url ?? TYPESAFE_URL).replace(/\/+$/, "");
  return {
    name: "typesafe",
    async decide(state, questions, signal) {
      const response = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(typeSafeRequest(state, questions, options.model)),
        signal,
      });
      if (!response.ok)
        throw new Error(
          `typesafe answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      return typeSafeAnswers(await response.json(), questions);
    },
  };
}
