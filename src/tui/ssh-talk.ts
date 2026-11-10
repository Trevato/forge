/**
 * `ssh <forge> talk <words>`: the forge's own agent, in one line from any
 * shell. An exec of `talk` calls the same `talk()` the API and the MCP use,
 * as the account the presented key belongs to, and prints that the agent is
 * answering; the answer is read back with `forge talk` or on the feed. The
 * words are the rest of the command line as given: no shell, no expansion; a
 * control character is refused before anything runs. `talk /stop` (or
 * `--stop`) ends the running answer, as Stop does on /talk: what the agent
 * had said stays, its processes end, a held write is cancelled.
 *
 * While an answer runs, `talk /queue <words>` keeps the words for after it
 * (`talk /queued` lists what waits, `talk /unqueue <id>` takes one back) and
 * `talk /steer <words>` stops the answer and sends them at once (#8819).
 *
 * `talk-again edit <words>`, `talk-again regenerate` and `talk-again retry`
 * are the same three actions the page has (#8817), through `talkAgain`.
 *
 * `talk --about owner/repo[#N] [words]` first prints the same one line the
 * page shows above its composer ("About owner/repo#N: title"), and nothing
 * when the subject is malformed, unknown or not the person's to read; with
 * no words it prints only that line.
 *
 * `talk --attach <name> <words>` sends one file with the words: its bytes are
 * the exec's standard input (`cat shot.png | ssh <forge> talk --attach
 * shot.png look at this`). The forge never opens a path of its own, so the
 * client's file is the only one that can be sent; it is checked and kept as
 * the page's attachments are (`core/conversation_files.ts`).
 */

import { cancelTalk, queuedTalk, TALK_WORDS, stopTalk, talk, talkAgain } from "../actions/talk.ts";
import { FILE_WORDS, IMAGE_MAX, pendingAmong, removePending, storeFile } from "../core/conversation_files.ts";
import { contextOf, contextText, dollars, turnCosts } from "../core/conversation_cost.ts";
import { openConversation } from "../core/conversations.ts";
import { aboutLine } from "../core/talk_about.ts";
import type { App } from "../app.ts";
import type { RedoHow } from "../crew/conversation.ts";
import type { User } from "../core/users.ts";
import { CONTROL_WORDS } from "./ssh-tell.ts";
import type { SshSession } from "../ssh/server.ts";

const CRLF = "\r\n";

/** The words after `talk`, as given; undefined when the command is not a talk. */
export function parseTalkCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const m = /^talk(?:[ \t]+([\s\S]*))?$/.exec(command.trim());
  return m === null ? undefined : (m[1] ?? "");
}

/** The words that stop the running answer instead of being said. */
export function isStop(words: string): boolean {
  return words.trim() === "/stop" || words.trim() === "--stop";
}

/** `/queue <words>` or `/steer <words>`: what to do with the words while an answer runs; undefined for plain words. */
export function parseDuring(words: string): { during: "queue" | "interrupt"; words: string } | undefined {
  const m = /^\/(queue|steer)(?:[ \t]+([\s\S]*))?$/.exec(words.trim());
  return m === null ? undefined : { during: m[1] === "queue" ? "queue" : "interrupt", words: m[2] ?? "" };
}

/** `--attach <name> <words>`: the name given to the file and the words after it; undefined without the flag. */
export function parseAttach(words: string): { name: string; words: string } | undefined {
  const m = /^--attach[ \t]+(\S+)(?:[ \t]+([\s\S]*))?$/.exec(words.trim());
  return m === null ? undefined : { name: m[1]!, words: m[2] ?? "" };
}

/** `--about <ref> <words>`: the subject named and the words after it; undefined without the flag. */
export function parseAbout(words: string): { about: string; words: string } | undefined {
  const m = /^--about[ \t]+(\S+)(?:[ \t]+([\s\S]*))?$/.exec(words.trim());
  return m === null ? undefined : { about: m[1]!, words: m[2] ?? "" };
}

/** Standard input to its end, or `too_large` past `max` bytes. */
function readStdin(session: SshSession, max: number): Promise<Uint8Array | "too_large"> {
  return new Promise((resolve) => {
    const parts: Uint8Array[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Uint8Array | "too_large"): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    session.onData((d) => {
      size += d.length;
      if (size > max) return finish("too_large");
      parts.push(d);
    });
    session.onEof(() => finish(Buffer.concat(parts)));
    session.onClose(() => finish(Buffer.concat(parts)));
  });
}

/** Run one `talk` exec for `user` (undefined: an unknown key). */
export function serveTalk(app: App, session: SshSession, user: User | undefined, words: string): void {
  const refuse = (text: string): void => {
    session.writeStderr(`forge: ${text}${CRLF}`);
    session.exit(1);
  };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(words)) return refuse(CONTROL_WORDS);
  // `/queued` lists the messages waiting for the running answer; `/unqueue <id>` takes one back.
  if (words.trim() === "/queued") {
    const waiting = queuedTalk(app, user);
    session.write(waiting.length === 0 ? `nothing is waiting${CRLF}` : waiting.map((q) => `${q.id}  ${q.text.slice(0, 80)}${CRLF}`).join(""));
    return session.exit(0);
  }
  const unqueue = /^\/unqueue[ \t]+(\S+)$/.exec(words.trim());
  if (unqueue !== null) {
    if (!cancelTalk(app, user, unqueue[1]!)) return refuse("that message already went, or was never waiting");
    session.write(`cancelled${CRLF}`);
    return session.exit(0);
  }
  const subject = parseAbout(words);
  if (subject !== undefined) {
    const line = aboutLine(app.db, subject.about, user);
    if (line !== null) session.write(`${line.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")}${CRLF}`);
    if (subject.words.trim() === "") return session.exit(0);
    words = subject.words;
  }
  const during = parseDuring(words);
  if (during !== undefined) words = during.words;
  if (isStop(words)) {
    const stopped = stopTalk(app, user);
    if (!stopped.ok)
      return refuse(
        stopped.error === "idle" ? "no answer is running" : stopped.error === "off" ? TALK_WORDS.off[1] : TALK_WORDS.unauthorized[1],
      );
    session.write(`stopped the forge's agent; what it said stays${CRLF}`);
    return session.exit(0);
  }
  const finish = (said: ReturnType<typeof talk>): void => {
    if (!said.ok) return refuse(TALK_WORDS[said.error][1]);
    session.write(
      `${said.value.how === "steered" ? "said to the forge's agent, mid-answer" : said.value.how === "queued" ? `queued, it sends after this answer (cancel: talk /unqueue ${said.value.queued})` : said.value.how === "interrupted" ? "stopped the answer; sending now" : "the forge's agent is answering"}${CRLF}`,
    );
    if (user !== undefined) {
      // The figures of the turn before this one, from its own usage record.
      const conversation = openConversation(app.db, user.id);
      const last = [...turnCosts(app.db, conversation.id).values()].at(-1);
      const context = contextOf(app.db, conversation.id);
      if (last !== undefined) session.write(`last turn ${dollars(last)}${CRLF}`);
      if (context !== undefined) session.write(`${contextText(context)}${CRLF}`);
    }
    session.exit(0);
  };
  const attach = parseAttach(words);
  if (attach === undefined) return finish(talk(app, user, words, [], during?.during ?? "inject"));
  if (user === undefined) return refuse(TALK_WORDS.unauthorized[1]);
  void readStdin(session, IMAGE_MAX).then((bytes) => {
    if (bytes === "too_large") return refuse(FILE_WORDS.too_large[1]);
    const stored = storeFile(app.db, app.config.dataDir, user.id, attach.name, bytes);
    if (!stored.ok) return refuse(FILE_WORDS[stored.error][1]);
    const files = pendingAmong(app.db, user.id, [stored.value.id]);
    const said = talk(app, user, attach.words, files.ok ? files.value : [], during?.during ?? "inject");
    // A message that was not taken leaves no file waiting behind it.
    if (!said.ok) removePending(app.db, app.config.dataDir, user.id, stored.value.id);
    finish(said);
  });
}

/** `talk-again <edit words | regenerate | retry>`; undefined when the command is not one. */
export function parseTalkAgain(command: string | undefined): { how: RedoHow; words: string } | undefined {
  if (command === undefined) return undefined;
  const m = /^talk-again[ \t]+(edit|regenerate|retry)(?:[ \t]+([\s\S]*))?$/.exec(command.trim());
  return m === null ? undefined : { how: m[1] as RedoHow, words: m[2] ?? "" };
}

/** Run one `talk-again` exec for `user` (undefined: an unknown key). */
export function serveTalkAgain(app: App, session: SshSession, user: User | undefined, how: RedoHow, words: string): void {
  const refuse = (text: string): void => {
    session.writeStderr(`forge: ${text}${CRLF}`);
    session.exit(1);
  };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(words)) return refuse(CONTROL_WORDS);
  const said = talkAgain(app, user, how, words);
  if (!said.ok) return refuse(TALK_WORDS[said.error][1]);
  session.write(`the forge's agent is answering again${CRLF}`);
  session.exit(0);
}
