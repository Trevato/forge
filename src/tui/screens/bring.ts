/**
 * "Bring an app" in the terminal: the door beside `/bring`. Paste the link to
 * an app on another forge; it is mirrored (the same job card a mirror shows),
 * registered as a private app once whole, and then each name its
 * `.env.example` asks for is prompted for, masked. Empty leaves it unset.
 */

import { bringLanded, setBroughtEnv, startBring, type BringError, type Brought } from "../../actions/bring.ts";
import type { MirrorJob } from "../../origins/jobs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { promptScreen, runAsync } from "./common.ts";
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

export function bringScreen(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "Bring an app",
    label: "Link to the app",
    placeholder: "https://codeberg.org/ana/notes",
    hint: "On a forge you have connected. Its data and secrets stay behind.",
    onSubmit: (link) => {
      const started = startBring(f.app, f.user, link);
      if (!started.ok) return bringWords(started.error);
      const { job, originId } = started.value;
      return Promise.resolve().then(() =>
        showMirrorJob(f, ctx, job, {
          parent,
          originId,
          fullName: job.fullName,
          onLanded: () => land(f, ctx, parent, job),
        }),
      );
    },
  });
}
