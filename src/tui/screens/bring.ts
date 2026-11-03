/**
 * "Bring an app" in the terminal: the door beside `/bring`. Paste the link to
 * an app on another forge; it is mirrored (the same job card a mirror shows),
 * registered as a private app once whole, and then each name its
 * `.env.example` asks for is prompted for, masked. Empty leaves it unset.
 */

import { bringLanded, setBroughtEnv, startBring, type BringError, type Brought } from "../../actions/bring.ts";
import { connectOrigin, connectRefusal } from "../../actions/origins.ts";
import { connectWords } from "../../actions/origin_words.ts";
import { connectSite, PLAIN_HTTP_WORDS } from "../../origins/bring.ts";
import type { MirrorJob } from "../../origins/jobs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { later, promptScreen, runAsync } from "./common.ts";
import { showMirrorJob } from "./mirror.ts";

/** The words for a refusal, as the page says them. */
export function bringWords(e: BringError): string {
  switch (e.kind) {
    case "connect":
      return `Sign in to ${e.host} first (connect your account there), then try again.`;
    case "invalid":
      return e.message;
    case "unverified":
      return "Verify your email first: an app runs code.";
    case "unauthorized":
      return "Only a person's own account brings an app.";
  }
}

function askNext(f: Session, ctx: Ctx, parent: Screen, brought: Brought, asking: readonly string[]): void {
  const [name, ...rest] = asking;
  if (name === undefined) return;
  ctx.push(
    promptScreen(ctx, parent, {
      title: "What it needs",
      label: name,
      hint: "Sealed, and the app redeploys. Empty leaves it unset.",
      mask: true,
      onSubmit: (value) => {
        runAsync(ctx, async () => {
          await setBroughtEnv(f.app, f.user!, brought, new Map([[name, value]]));
          if (rest.length > 0) askNext(f, ctx, parent, brought, rest);
          else ctx.toast("Saved. The app redeploys.", "success");
        });
        return undefined;
      },
    }),
  );
}

function land(f: Session, ctx: Ctx, parent: Screen, job: MirrorJob): void {
  runAsync(ctx, async () => {
    const brought = await bringLanded(f.app, f.user!, job);
    if (!brought.ok) {
      ctx.toast(brought.error.message, "danger");
      return;
    }
    const asking = brought.value.needs.filter((n) => !n.set).map((n) => n.name);
    ctx.toast(`${job.fullName} is deploying here, private.`, "success");
    askNext(f, ctx, parent, brought.value, asking);
  });
}

/** Start the bring for a link and show its job; the answer in words when it cannot start. */
function begin(f: Session, ctx: Ctx, parent: Screen, link: string): string | Promise<void> | undefined {
  const started = startBring(f.app, f.user, link);
  if (!started.ok) return started.error.kind === "connect" ? connectFirst(f, ctx, parent, link, started.error.host) : bringWords(started.error);
  const { job, originId } = started.value;
  return Promise.resolve().then(() =>
    showMirrorJob(f, ctx, job, {
      parent,
      originId,
      fullName: job.fullName,
      onLanded: () => land(f, ctx, parent, job),
    }),
  );
}

/**
 * The link names a forge no account here is connected to: ask for a token made
 * on it (masked), connect, and carry on with the same link. Plain http is
 * refused, as the page does, unless this is a development forge.
 */
function connectFirst(f: Session, ctx: Ctx, parent: Screen, link: string, host: string): string | Promise<void> {
  const site = connectSite(link, host);
  if (!site.ok) return PLAIN_HTTP_WORDS;
  return later(ctx, () =>
    promptScreen(ctx, parent, {
      title: `Connect ${host} first`,
      label: `Token for ${host}`,
      hint: `Made at ${site.value}/settings/tokens; read is enough. Kept encrypted here.`,
      mask: true,
      onSubmit: (token) => {
        if (token.trim() === "") return "Paste the token.";
        ctx.toast(`Connecting ${host}…`);
        return connectOrigin(f.app, f.user!, { host: site.value, token }).then((r) => {
          if (!r.ok) {
            const refused = connectRefusal(r.error);
            ctx.toast(refused.message ?? connectWords(refused.code), "danger");
            return;
          }
          ctx.toast(`Connected ${r.value.login} at ${host}.`, "success");
          const next = begin(f, ctx, parent, link);
          if (typeof next === "string") ctx.toast(next, "danger");
        });
      },
    }),
  );
}

export function bringScreen(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "Bring an app",
    label: "Link to the app",
    placeholder: "https://codeberg.org/ana/notes",
    hint: "On another forge. If you have not connected it, you are asked for a token. Its data and secrets stay behind.",
    onSubmit: (link) => begin(f, ctx, parent, link),
  });
}
