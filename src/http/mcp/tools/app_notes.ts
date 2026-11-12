import { moderateNote, ownerNotes, unbanSender } from "../../../actions/app_notes.ts";
import { getAppByRepo } from "../../../core/apps.ts";
import { good, bad, type Answer, type Tool, APP_ARG, planRepo, isAnswer, str } from "../shared.ts";

const ACTIONS = ["hide", "ban", "unban"] as const;
type Action = (typeof ACTIONS)[number];

/** The same gate and the same moderation as the studio's card and the terminal's notes screen. */
const refused = (error: "forbidden" | "not_found" | "unavailable"): Answer =>
  error === "forbidden"
    ? bad("forbidden", "an app's notes are for an admin of its repository")
    : error === "not_found"
      ? bad("not_found", "no such note in this app")
      : bad("unavailable", "the note's issue could not be closed just now");

export const tool: Tool = {
  name: "app_notes",
  doc: "`{ app, action?, note? }`: the notes sent from an app's forge button, each with its latest `replies` (outsiders' `untrusted`), and its banned senders; `hide` a note, `ban` or `unban` its sender; an admin of the repository",
  description: "Notes from an app's forge button and banned senders; hide a note, ban or unban its sender. Admin.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      action: { type: "string", enum: [...ACTIONS] },
      note: { type: "string" },
    },
    required: ["app"],
  },
  writes: true,
  readsWithout: "action",
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const record = getAppByRepo(ctx.app.db, repo.id);
    if (record === undefined) return bad("not_found", "no such app or repository (owner/name)");
    const action = args["action"];
    if (action === undefined) {
      const seen = ownerNotes(ctx.app, record, repo, user);
      return seen === undefined ? refused("forbidden") : good(seen);
    }
    if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action))
      return bad("invalid", "`action` is hide, ban or unban");
    const note = str(args["note"]);
    if (note === "" || note.length > 64) return bad("invalid", "`note` is a note's id, from the list");
    const done =
      (action as Action) === "unban"
        ? unbanSender(ctx.app, record, repo, user, note)
        : await moderateNote(ctx.app, record, repo, user, note, action as "hide" | "ban");
    return done.ok ? good({ note, action, says: `Done: ${action} on note ${note}.` }) : refused(done.error);
  },
};
