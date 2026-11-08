import { listRemoteRepos, listUserOrigins, syncOriginNow } from "../../../actions/origins.ts";
import { originJson, remoteRepoJson } from "../../api.ts";
import { ORIGIN_UNREACHABLE } from "../../../actions/origin_app_words.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { trustedHosts } from "../trusted_hosts.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "origins",
  doc: "`{ action, id?, hosts? }`: `list` your connected origins, `repos` the repositories one holds (`id`; `mirroredAs` says which are already here), `sync` one now, or `hosts`: with no `hosts`, read the internal hosts an origin may live on (a forge admin, `fromEnv` read-only), with `hosts` (one per line) replace them as Settings → Origins does, a rejected line named in the error; the same as `GET /api/v1/user/origins`, `…/:id/repos` and `POST …/:id/sync`, for you only, an admin token as there; never a credential in an answer",
  description:
    "Origins: list, repos, sync, hosts.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "repos", "sync", "hosts"] },
      id: { type: "string" },
      hosts: { type: "string" },
    },
    required: ["action"],
  },
  writes: true,
  readsWithout: ["id", "hosts"],
  async run(ctx, user, args) {
    const action = args["action"];
    const id = args["id"];
    if (action === "hosts") return trustedHosts(ctx, user, args);
    if (action !== "list" && action !== "repos" && action !== "sync")
      return bad("bad_action", "`action` is list, repos, sync or hosts");
    if (action !== "list" && (typeof id !== "string" || id === ""))
      return bad("invalid", "send the origin's `id`, from list");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "origins spend your credential elsewhere and need an admin token");
    if (action === "list")
      return good(listUserOrigins(ctx.app, user).map(originJson));
    const origin = id as string;
    if (action === "sync") {
      const synced = await syncOriginNow(ctx.app, user, origin);
      return synced.ok ? good(synced.value) : bad("not_found", "no such origin");
    }
    const listed = await listRemoteRepos(ctx.app, user, origin);
    if (!listed.ok)
      return listed.error === "unreachable"
        ? bad("origin_unreachable", ORIGIN_UNREACHABLE)
        : bad("not_found", "no such origin");
    return good(listed.value.map((row) => remoteRepoJson(ctx, row)));
  },
};
