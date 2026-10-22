/**
 * The forge button's notes, from a repository screen's `:` palette (#4758):
 * the terminal's door to what the button does on an app's page, with the
 * page's gating. A signed-in person who reads the repository may send a note
 * and see their own with its status; the repository's admin sees every
 * sender's and may hide a note or ban its sender. A repository that is not
 * an app, or a guest, gets no rows.
 */

import { moderateNote, notesFor, sendNote, type Sender } from "../../actions/app_notes.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, canEnterApp, canRead, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { confirmScreen, pickerScreen, promptScreen } from "./common.ts";

export function noteCommands(f: Session, ctx: Ctx, parent: () => Screen, repo: Repo | undefined): Command[] {
  const user = f.user;
  if (repo === undefined || user === undefined || !canRead(f.app.db, repo, user)) return [];
  const record = getAppByRepo(f.app.db, repo.id);
  // The page's entry check: a private app takes notes only from those it admits.
  if (record === undefined || !canEnterApp(f.app.db, repo, record, user)) return [];
  const name = `${repo.ownerName}/${repo.name}`;
  const sender: Sender = { key: `u:${user.id}`, name: `@${user.username}`, person: true };
  const admin = canAdmin(f.app.db, repo, user);
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
              (async () => {
                const sent = await sendNote(f.app, record, repo, "production", undefined, sender, { text: said, page: "", viewport: "unknown" }, `ssh:${user.id}`);
                if (sent.ok) ctx.toast("Sent. The builders will see it.", "success");
                else ctx.toast(sent.error.message, "danger");
              })(),
          }),
        ),
    },
    {
      id: "notes",
      title: `${name} — Notes from the app`,
      hint: admin ? "every sender's; hide or ban" : "yours, with their status",
      run: () => {
        const notes = notesFor(f.app, record, repo, undefined, sender, admin);
        if (notes.length === 0) return ctx.toast("No notes yet.");
        ctx.push(
          pickerScreen(ctx, parent(), {
            title: "Notes from the app",
            items: notes.map((n) => ({ id: n.id, label: n.text, hint: `${n.status.label} — ${n.by}` })),
            onPick: ([id]) => {
              const picked = notes.find((n) => n.id === id);
              if (picked === undefined) return;
              if (!admin) return ctx.toast(`${picked.status.label}.`);
              ctx.push(
                confirmScreen(ctx, parent(), {
                  title: "Moderate this note",
                  body: [`${picked.by}: ${picked.text}`, picked.status.label],
                  actions: [{ label: "Keep", variant: "ghost" }, { label: "Hide" }, { label: "Ban sender", variant: "danger" }],
                  onChoose: (i) => {
                    if (i < 1) return;
                    void moderateNote(f.app, record, repo, user, picked.id, i === 1 ? "hide" : "ban").then((done) =>
                      ctx.toast(done.ok ? (i === 1 ? "Hidden." : "Sender banned.") : "That could not be done.", done.ok ? "success" : "danger"),
                    );
                  },
                }),
              );
            },
          }),
        );
      },
    },
  ];
}
