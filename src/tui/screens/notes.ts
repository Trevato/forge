/**
 * The forge button's notes, from a repository screen's `:` palette (#4758):
 * the terminal's door to what the button does on an app's page, with the
 * page's gating. A signed-in person who reads the repository may send a note
 * and see their own with its status; the repository's admin sees every
 * sender's and may hide a note or ban its sender, see the banned senders and unban them. A repository that is not
 * an app, or a guest, gets no rows.
 */

import { moderateNote, notesFor, ownerNotes, sendNote, unbanSender, type Sender } from "../../actions/app_notes.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, canEnterApp, canRead, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { confirmScreen, pickerScreen, promptScreen } from "./common.ts";

/** "2 replies", "1 reply": what a note's list line says of the answers under it. */
export const repliesWord = (n: number): string => `${n} repl${n === 1 ? "y" : "ies"}`;

export function noteCommands(f: Session, ctx: Ctx, parent: () => Screen, repo: Repo | undefined): Command[] {
  const user = f.user;
  if (repo === undefined || user === undefined || !canRead(f.app.db, repo, user)) return [];
  const record = getAppByRepo(f.app.db, repo.id);
  // The page's entry check: a private app takes notes only from those it admits.
  if (record === undefined || !canEnterApp(f.app.db, repo, record, user)) return [];
  const name = `${repo.ownerName}/${repo.name}`;
  const sender: Sender = { key: `u:${user.id}`, name: `@${user.username}`, person: true };
  const admin = canAdmin(f.app.db, repo, user);
  const unban: Command[] = [];
  if (admin) {
    unban.push({
      id: "banned",
      title: `${name} — Banned senders`,
      hint: "unban a sender",
      run: () => {
        const banned = ownerNotes(f.app, record, repo, user)?.banned ?? [];
        if (banned.length === 0) return ctx.toast("No one is banned.");
        ctx.push(
          pickerScreen(ctx, parent(), {
            title: "Banned senders",
            items: banned.map((n) => ({ id: n.id, label: n.by, hint: n.text })),
            onPick: ([id]) => {
              const picked = banned.find((n) => n.id === id);
              if (picked === undefined) return;
              ctx.push(
                confirmScreen(ctx, parent(), {
                  title: "Unban this sender",
                  body: [picked.by, picked.text],
                  actions: [{ label: "Keep banned", variant: "ghost" }, { label: "Unban" }],
                  onChoose: (i) => {
                    if (i < 1) return;
                    const done = unbanSender(f.app, record, repo, user, picked.id);
                    ctx.toast(done.ok ? "Sender unbanned." : "That could not be done.", done.ok ? "success" : "danger");
                  },
                }),
              );
            },
          }),
        );
      },
    });
  }
  return [
    {
      id: "note",
      title: `${name} — Tell the builders`,
      hint: "send a note",
      run: () =>
        ctx.push(
          promptScreen(ctx, parent(), {
            title: "Tell the builders",
            label: name,
            hint: "enter sends",
            onSubmit: (said) =>
              ctx.track((async () => {
                const sent = await sendNote(f.app, record, repo, "production", undefined, sender, { text: said, page: "", viewport: "unknown" }, `ssh:${user.id}`, user);
                if (sent.ok) ctx.toast(`Sent as #${sent.value.number}, ${name}/issues/${sent.value.number}. The builders will see it.`, "success");
                else ctx.toast(sent.error.message, "danger");
              })()),
          }),
        ),
    },
    {
      id: "notes",
      title: `${name} — Notes from the app`,
      hint: admin ? "every sender's; hide or ban" : "yours, with their status",
      run: () => {
        const notes = notesFor(f.app, record, repo, undefined, sender, admin, user);
        if (notes.length === 0) return ctx.toast("No notes yet.");
        ctx.push(
          pickerScreen(ctx, parent(), {
            title: "Notes from the app",
            items: notes.map((n) => ({ id: n.id, label: `#${n.number} ${n.text}${n.replies.length > 0 ? ` (${repliesWord(n.replies.length)})` : ""}`, hint: `${n.status.label} — ${n.by}` })),
            onPick: ([id]) => {
              const picked = notes.find((n) => n.id === id);
              if (picked === undefined) return;
              const said = picked.replies.map((r) => `${r.by} ${r.at.slice(0, 16).replace("T", " ")}: ${r.text}`);
              if (!admin && said.length > 0)
                return ctx.push(confirmScreen(ctx, parent(), { title: `#${picked.number}: ${picked.status.label}`, body: said, actions: [{ label: "Close", variant: "ghost" }], onChoose: () => {} }));
              if (!admin) return ctx.toast(`#${picked.number}: ${picked.status.label}.`);
              ctx.push(
                confirmScreen(ctx, parent(), {
                  title: "Moderate this note",
                  body: [`#${picked.number} ${picked.by}: ${picked.text}`, picked.status.label, ...said],
                  actions: [{ label: "Keep", variant: "ghost" }, { label: "Hide" }, { label: "Ban sender", variant: "danger" }],
                  onChoose: (i) => {
                    if (i < 1) return;
                    // Tracked, so the screen is not settled until the note is moderated.
                    void ctx.track(
                      moderateNote(f.app, record, repo, user, picked.id, i === 1 ? "hide" : "ban").then((done) =>
                        ctx.toast(done.ok ? (i === 1 ? "Hidden." : "Sender banned.") : "That could not be done.", done.ok ? "success" : "danger"),
                      ),
                    );
                  },
                }),
              );
            },
          }),
        );
      },
    },
    ...unban,
  ];
}
