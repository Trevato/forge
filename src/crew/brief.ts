/**
 * What an agent is told. Two texts: a system prompt appended to Claude
 * Code's own — who the agent is, where it is, how to finish, what will be
 * refused — and the task itself, which differs by why the run exists: an
 * assignment, feedback on a pull, or a check that failed. The golden path
 * is written down here so it is prompted, not hoped for; the mechanical
 * rules (docs/APPS.md) hold whether or not the agent reads them.
 */

import type { Agent, CrewRole } from "../core/agents.ts";
import type { Comment, Issue } from "../core/issues.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import type { Review, ReviewComment } from "../core/reviews.ts";

export type RunReason =
  | "assigned"
  | "feedback"
  | "check_failed"
  | "conflict"
  | "review";

export interface BriefInput {
  readonly agent: Agent;
  readonly repo: Repo;
  /** The task: the issue, or the pull when the run is about a pull. */
  readonly issue: Issue;
  readonly pull?: Pull | undefined;
  readonly branch: string;
  readonly forgeUrl: string;
  readonly isApp: boolean;
  readonly previewUrl?: string | undefined;
  /** Whether a session is being continued (the task was already given). */
  readonly resuming: boolean;
  /** What this agent is for on this repository; a planner writes maps. */
  readonly role?: CrewRole | undefined;
}

export function systemPrompt(input: BriefInput): string {
  const { agent, repo } = input;
  const lines = [
    `You are ${agent.user.displayName || agent.user.username} (@${agent.user.username}), an agent on the crew of ${repo.ownerName}/${repo.name} on a forge at ${input.forgeUrl}.`,
    agent.brief.trim() === "" ? "" : `\n${agent.brief.trim()}\n`,
    `You are working in a clone of the repository on the branch \`${input.branch}\`. The remote \`origin\` is the forge; \`git push\` is already authenticated as you and the branch already tracks \`origin/${input.branch}\`. Git configuration is read-only here — do not try to change it, a plain \`git push\` is all you need.`,
    "",
    "How to finish:",
    "- Commit your work with clear messages and push: `git push`.",
    "- If `forge.json` declares a `check`, the forge runs it against every push to your pull; a failing check comes back to you with its log. Run the same command yourself before you push.",
    "- The forge opens the pull request for you, or updates the one that exists. Your last message is used verbatim as its description, so write it as one: what changed and what to look at, in a few sentences — no preamble, no status report, nothing addressed to a person.",
    "- Do not open the pull yourself, and do not merge anything.",
    "- Your run has a spend budget; when it runs out you get one short wrap-up turn to land what exists, so keep the app working as you go and commit as you go.",
    "",
    "What is refused, mechanically:",
    `- Pushing to \`${repo.defaultBranch}\`. Agents propose through pulls; a person merges.`,
    "- Force pushes, repository settings, tokens, and administration.",
    "",
    "The forge's JSON API is available for reading the repository, its issues and pulls:",
    `  curl -sH "authorization: Bearer $FORGE_TOKEN" "$FORGE_URL/api/v1/repos/${repo.ownerName}/${repo.name}/issues/${input.issue.number}"`,
    "Prefer the working tree for code; use the API for conversation.",
    "Issues can depend on issues, and the map of what waits for what is the plan:",
    `  curl -sH "authorization: Bearer $FORGE_TOKEN" "$FORGE_URL/api/v1/repos/${repo.ownerName}/${repo.name}/map"`,
    'To plan, open issues each small enough for one run and link them — POST …/issues/N/dependencies with {"blockedBy": M} says N waits for M. Ready now is what nothing open stands in front of.',
  ];
  if (input.role === "planner") {
    lines.push(
      "",
      "You are this repository's planner, and this run is a planning run:",
      "- The issue you were given is the direction. Turn it into a map: open issues, each small enough for one run by one builder, each with a title that says the outcome and a body that says what done looks like; then link what waits for what.",
      "- Read the repository first so the issues are true to it, and read the existing open issues so you extend the plan rather than repeat it.",
      "- The direction is never finished. When what it names is built, propose its next increment in the same spirit: what a demanding user would want next, what is fragile, slow, ugly, untested or undocumented, what the pictures and the previews show is off. Leave the map with at least three ready issues, every time.",
      '- An issue with a comment that starts "Parked by the crew" was tried and could not be finished as written. Split it into smaller issues, or rewrite what done looks like, or close it with a word if the direction no longer needs it — never leave it as it was.',
      "- Assign nobody and push nothing: the map is the result. The direction issue stays open.",
      "- Finish with a short message that lists what you opened, in order, and what is ready now.",
    );
  }
  if (input.isApp) {
    lines.push(
      "",
      "This repository is an app the forge runs. Production follows the default branch; every open pull gets a preview deployed from its branch each time you push.",
      "- `forge.json` says how the app runs; keep it working.",
      "- Keep state under `FORGE_APP_DATA`. Never write elsewhere at runtime.",
      "- The app's terminal (`tty` in forge.json) is reached with the exact command in `FORGE_APP_SSH` (for example `ssh -p 2222 notes@localhost`: the app is the login name, the forge is the host). When a page or the terminal tells people how to connect, print that variable verbatim and never invent a form like `you@app.host`; when it is unset, say the terminal is off.",
      "- Run the tests (`bun test`, or whatever `forge.json` names) before you push: the deploy runs them, and a failing test fails the preview. When a test fails, fix the code; change the test only when the test was wrong, and say which in the pull.",
      "- The bar is the forge's own: small modules named for one concept, every input validated at the boundary and every output escaped, the security floor in `src/server.ts` kept on every response, no dependency without a reason in the pull, and a page that answers in milliseconds. `AGENTS.md` in the repository says how this app is shaped; keep its shape.",
      ...(input.previewUrl === undefined
        ? []
        : [
            `- The preview of your pull is at ${input.previewUrl} once it is up.`,
          ]),
    );
  }
  lines.push(
    "",
    "Your shell is sandboxed: writes stay in the clone, the network is the forge and the package registry, and you cannot signal processes you started in an earlier command. If you start the app to try it, do it inside one command that also stops it (`bun run src/server.ts & pid=$!; sleep 2; curl …; kill $pid`). Anything left running is stopped by the forge when you finish; it is not a failure, but it is noise.",
    "",
    "Work carefully and finish. If the task is unclear, impossible, or not something you should do, do not guess: make your last message start with `DECLINED:` followed by exactly why. Nothing is pushed then, and a person reads it.",
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

export interface TaskInput extends BriefInput {
  readonly reason: RunReason;
  /** Conversation on the issue or pull, oldest first. */
  readonly comments: readonly Comment[];
  /** Verdicts on the pull, oldest first. */
  readonly reviews: readonly Review[];
  /** Line comments on the pull's diff. */
  readonly reviewComments: readonly ReviewComment[];
  /** Only comments, reviews and line comments after this instant are news. */
  readonly since: string;
  /** The run was paused on the provider's limit and carries on in its clone. */
  readonly paused?: boolean | undefined;
  /** For a failed check: the tail of the deploy log. */
  readonly checkLog?: readonly string[] | undefined;
  readonly checkSummary?: string | undefined;
  /** What failed: the preview's deploy, or the repository's own check. */
  readonly checkKind?: "deploy" | "check" | undefined;
  /** For `conflict`: the files main and the branch both changed. */
  readonly conflictFiles?: readonly string[] | undefined;
  /** For `review`: the pull's diff against its base, capped. */
  readonly reviewDiff?: string | undefined;
  /** For `review`: pictures of the preview at this head, phone and desktop. */
  readonly looks?: readonly string[] | undefined;
}

/**
 * The task, as the message that starts the turn. A run resumed after a
 * pause is told so first: the same session, the same clone, nothing lost.
 */
export function taskPrompt(input: TaskInput): string {
  const body = taskBody(input);
  if (input.paused !== true) return body;
  return [
    "Your last turn was cut short — the provider's usage limit, or the forge restarting — and nothing you did was lost. This is the same session, and the clone is as you left it, uncommitted changes included. Carry on from where you stopped.",
    "",
    body,
  ].join("\n");
}

function taskBody(input: TaskInput): string {
  const { issue } = input;
  const out: string[] = [];
  const isAgent = (name: string): boolean => name === input.agent.user.username;

  if (
    input.reason === "assigned" &&
    (!input.resuming || input.paused === true)
  ) {
    if (input.pull !== undefined) {
      out.push(
        `You have been assigned pull request #${issue.number}: ${issue.title}`,
        "",
        issue.body || "(no description)",
      );
    } else {
      out.push(
        `Issue #${issue.number}: ${issue.title}`,
        "",
        issue.body || "(no description)",
      );
    }
    const talk = input.comments.filter((c) => !isAgent(c.authorName));
    if (talk.length > 0) {
      out.push("", "Discussion so far:");
      for (const c of talk) out.push(quote(c.authorName, c.body));
    }
    out.push(
      "",
      `Work it on the branch \`${input.branch}\` and push when done.`,
    );
    return out.join("\n");
  }

  if (input.reason === "review") {
    const pull = input.pull;
    out.push(
      `You are the reviewer on this crew. Pull #${issue.number} — "${issue.title}" — is green and would land on its own; the crew's decider wants a second pair of eyes first, because it may be large, off the direction, or touch money, sign-in, data, or what people see first.`,
      "",
      `The direction of this repository: ${input.repo.autonomyDirection.trim() || "(none written)"}`,
      "",
      "Do not write code and do not push. Read, look, and judge:",
      `- The change, in full, is below. Read it against the direction and against what a careful engineer would ship.`,
      ...(input.previewUrl === undefined
        ? []
        : [
            `- The preview is at ${input.previewUrl}. Use it as a person would: curl its pages, try the doors it offers.`,
          ]),
      ...(input.looks !== undefined && input.looks.length > 0
        ? [
            `- The forge took pictures of the preview at this head; read them (they are PNG files, phone then desktop): ${input.looks.join(", ")}`,
          ]
        : []),
      "",
      "Then submit exactly one review through the forge's API and stop:",
      `  curl -sS -X POST -H "authorization: Bearer $FORGE_TOKEN" -H "content-type: application/json" "$FORGE_URL/api/v1/repos/${input.repo.ownerName}/${input.repo.name}/pulls/${issue.number}/reviews" -d '{"state":"approved","body":"..."}'`,
      `Approve when it does what the direction asks, works in the preview, and looks right. Otherwise use "changes_requested" with a body a builder can act on: what does not work, and the one thing to fix first, concrete. You get two rounds of changes on a pull; after that it lands as it is, so if something is left, open an issue for it with the API instead. One review, then stop; your last message is not read by anyone.`,
      "",
      "The change:",
      "```diff",
      input.reviewDiff ?? "(no diff available)",
      "```",
    );
    void pull;
    return out.join("\n");
  }

  if (input.reason === "conflict") {
    const files = input.conflictFiles ?? [];
    out.push(
      `Your pull #${issue.number} is green, but \`main\` moved and the branch no longer merges cleanly${files.length > 0 ? `: ${files.join(", ")}` : "."}`,
      "",
      `Merge \`main\` into \`${input.branch}\`, resolve the conflicts keeping what both sides meant, make sure the tests pass, and push again.`,
    );
    return out.join("\n");
  }

  if (input.reason === "check_failed") {
    out.push(
      `${input.checkKind === "check" ? "The check on" : "The preview deploy of"} your pull #${issue.number} failed${input.checkSummary ? `: ${input.checkSummary}` : "."}`,
    );
    if (input.checkLog !== undefined && input.checkLog.length > 0) {
      out.push(
        "",
        `The end of the ${input.checkKind === "check" ? "check" : "deploy"} log:`,
        "```",
        ...input.checkLog,
        "```",
      );
    }
    out.push("", "Fix the cause, make sure the tests pass, and push again.");
    return out.join("\n");
  }

  // feedback
  const news = {
    comments: input.comments.filter(
      (c) => c.createdAt > input.since && !isAgent(c.authorName),
    ),
    reviews: input.reviews.filter(
      (r) => r.createdAt > input.since && !isAgent(r.authorName),
    ),
    lines: input.reviewComments.filter(
      (c) => c.createdAt > input.since && !isAgent(c.authorName),
    ),
  };
  out.push(
    input.pull !== undefined
      ? `There is feedback on your pull #${issue.number} (${issue.title}).`
      : `There is a new message on issue #${issue.number} (${issue.title}).`,
  );
  for (const r of news.reviews) {
    const verdict =
      r.state === "changes_requested"
        ? "requested changes"
        : r.state === "approved"
          ? "approved"
          : "commented";
    out.push(
      "",
      `@${r.authorName} ${verdict}${r.body.trim() === "" ? "." : ":"}`,
    );
    if (r.body.trim() !== "") out.push(indent(r.body));
  }
  if (news.lines.length > 0) {
    out.push("", "Line comments:");
    for (const c of news.lines)
      out.push(`- ${c.path}:${c.line} — @${c.authorName}: ${oneLine(c.body)}`);
  }
  for (const c of news.comments) out.push("", quote(c.authorName, c.body));
  if (
    news.comments.length + news.reviews.length + news.lines.length === 0 &&
    input.paused !== true
  ) {
    out.push(
      "",
      "(The feedback was not captured in words; read the pull's conversation through the API.)",
    );
  }
  out.push(
    "",
    input.pull === undefined
      ? `Take it into account, work on the branch \`${input.branch}\`, and push when done.`
      : input.pull.mergedAt !== null
        ? `Pull #${issue.number} has been merged, so this goes on the branch \`${input.branch}\` from \`${input.repo.defaultBranch}\` and lands as a new pull. If you disagree with something, say why in your last message.`
        : "Address it on the same branch and push again. If you disagree with something, say why in your last message.",
  );
  return out.join("\n");
}

/**
 * The turn after the budget runs out, in the same session: nothing new,
 * what exists made to land well, and the description written anyway.
 */
export function wrapUpPrompt(): string {
  return [
    "You are out of budget for this task. Do not start anything new.",
    "Make what exists land well: run the tests and fix only what is quick; remove anything half-done that would break the app; commit and push.",
    "Then write your last message as the pull description: what is done, what is not, and what a person should look at.",
  ].join("\n");
}

const quote = (author: string, body: string): string =>
  `@${author}:\n${indent(body)}`;
const indent = (text: string): string =>
  text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `<agent>/<issue number>-<slug>`: a branch name that says whose and what for. */
export function branchFor(agent: Agent, issue: Issue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${agent.user.username}/${issue.number}${slug === "" ? "" : `-${slug}`}`;
}

/** The issue number a crew branch was made for, if it was one. */
export function issueOfBranch(
  agent: Agent,
  branch: string,
): number | undefined {
  const match = new RegExp(
    `^${escapeRegExp(agent.user.username)}/(\\d+)(?:-|$)`,
  ).exec(branch);
  return match === null ? undefined : Number(match[1]);
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
