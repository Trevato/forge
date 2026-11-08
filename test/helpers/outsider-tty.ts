/**
 * The outsider suite's terminal door (#663): a stranger drives the terminal
 * in process, the way `test/tui-quotas.test.ts` does, and each forbidden
 * thing must be refused where the screen says so. The terminal is a client
 * of the forge's actions, so it cannot be reached over HTTP: this runs in
 * the gate, not against a live forge.
 */

import type { App as Forge } from "../../src/app.ts";
import type { Refusal } from "../../src/release/outsider.ts";
import { getRepo } from "../../src/core/repos.ts";
import { getIssue } from "../../src/core/issues.ts";
import { NOT_A_MEMBER } from "../../src/core/roles.ts";
import type { User } from "../../src/core/users.ts";
import { createForgeApp } from "../../src/tui/forge.ts";
import { assignPicker } from "../../src/tui/screens/assign.ts";
import type { Screen } from "../../src/tui/app/app.ts";
import { Session } from "../../src/tui/session.ts";
import { headlessTerminal } from "../../src/tui/term/terminal.ts";
import { settleApp, settlePalette } from "./tui.ts";

/** What a refused toast reads like on the screen: the guest words' first sentence, as a long toast is cut at the edge. */
const REFUSAL = new RegExp(`${NOT_A_MEMBER.split(".")[0]}|unverified|do not have permission|need write access|not allowed`, "i");

export interface Target {
  owner: string;
  name: string;
  /** An issue number in it. */
  issue: number;
  /** A crew member's username to assign. */
  agent: string;
  hidden: boolean;
}

export async function outsiderTty(forge: Forge, stranger: User, targets: readonly Target[]): Promise<Refusal[]> {
  const bad: Refusal[] = [];
  const terminal = headlessTerminal(140, 32);
  const identity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: stranger };
  const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
  app.start();
  const press = async (...keys: string[]) => {
    for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  const ctrl = async (key: string) => {
    app.dispatch({ type: "key", key, ctrl: true, alt: false, shift: false });
    await settleApp(app);
  };
  const type = async (text: string) => {
    for (const ch of text) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  const seen = () => app.screen.toText();
  try {
    // A repository of its own, from the palette.
    const mine = `${stranger.username}-tty`;
    await ctrl("k");
    await type("New repository");
    await settlePalette(app);
    await press("enter");
    await type(mine);
    await ctrl("d");
    if (getRepo(forge.db, stranger.username, mine) !== undefined)
      bad.push({ check: "no repository of its own (terminal)", why: "the terminal made a repository for a stranger" });
    else if (!REFUSAL.test(seen()))
      bad.push({ check: "no repository of its own (terminal)", why: `no refusal on the screen:\n${seen()}` });
    await press("esc");
    await press("esc");

    for (const t of targets) {
      const label = `${t.owner}/${t.name}`;
      const repo = getRepo(forge.db, t.owner, t.name);
      const issue = repo ? getIssue(forge.db, repo.id, t.issue) : undefined;
      if (!repo || !issue) continue;
      if (t.hidden) {
        // A private repository is not on offer: the palette's search never names it.
        await ctrl("k");
        await type(t.name);
        await settlePalette(app);
        if (seen().includes(label)) bad.push({ check: `no read of private ${label} (terminal)`, why: "the palette names it for a stranger" });
        await press("esc");
        continue;
      }
      // Assign a crew member to a public repository's issue: the picker is the terminal's door.
      const before = issue.assigneeId;
      const parent: Screen = { title: "outsider", keys: [], render() {}, key: () => false };
      assignPicker(new Session(forge, identity), app.ctx, parent, repo, issue, () => {});
      await settleApp(app);
      await press("/");
      await type(t.agent);
      await press("enter", "enter");
      const after = getIssue(forge.db, repo.id, t.issue);
      if (after?.assigneeId !== before)
        bad.push({ check: `no steering of ${label} (terminal)`, why: "the terminal assigned a crew member for a stranger" });
      else if (!REFUSAL.test(seen()))
        bad.push({ check: `no steering of ${label} (terminal)`, why: `no refusal on the screen:\n${seen()}` });
      await press("esc");
    }
  } finally {
    app.stop();
  }
  return bad;
}
