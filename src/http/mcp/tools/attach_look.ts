import { attachLook } from "../../../actions/attach_look.ts";
import { lookUrl } from "../../../core/looks.ts";
import { getPull } from "../../../core/pulls.ts";
import { good, attachWords, bad, type Tool, str, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "attach_look",
  doc: "`{ app, pull, width, says, image, dryRun? }`: attach a look to an open pull: a PNG or JPEG (at most 5 MB, base64 in `image`), `width` phone or desktop, one line in `says`; planned first (`dryRun` is true unless `false`)",
  description:
    "Attach a PNG/JPEG (base64 `image`, max 5 MB) to an open pull: `phone`/`desktop`, `says`.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      pull: { type: "integer" },
      width: { type: "string", enum: ["phone", "desktop"] },
      says: {
        type: "string",
      },
      image: { type: "string" },
      dryRun: { type: "boolean" },
    },
    required: ["app", "pull", "width", "says", "image"],
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["pull"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined)
      return bad("no_such_pull", `no pull #${String(n)}`);
    const input = {
      width: str(args["width"]),
      note: str(args["says"]),
      image: typeof args["image"] === "string" ? args["image"] : "",
    };
    const name = `${repo.ownerName}/${repo.name}#${pull.number}`;
    const dry = args["dryRun"] !== false;
    const attached = attachLook(ctx.app, user, repo, pull, input, dry);
    if (!attached.ok) return bad(attached.error, attachWords(attached.error));
    if (dry)
      return good({
        says: `Would attach a ${input.width} look to ${name}. Nothing changed; send dryRun: false to do it.`,
        dryRun: true,
      });
    return good({
      says: `Attached a ${input.width} look to ${name}.`,
      url: lookUrl(`/${repo.ownerName}/${repo.name}`, attached.value),
      dryRun: false,
    });
  },
};
