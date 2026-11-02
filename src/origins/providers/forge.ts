/**
 * Another forge as an origin (`docs/features/forge-origin.md`).
 *
 * A forge answers the Gitea dialect only for the one list connecting needs,
 * `GET /user/repos`; who you are and one repository are read in its own
 * shape, so the rest of its API grows no Gitea fields. Git comes over HTTPS
 * as ever. What a forge does not yet answer to an origin is its issues,
 * pulls, comments and labels: those reads say "none" rather than failing, so
 * the mirror brings the code across and settles, and the origin's `carries`
 * note says what did not come.
 */

import type {
  Page,
  ProviderResult,
  RemoteIdentity,
  RemoteLabel,
  RemoteMilestone,
  RemoteIssue,
  RemoteRepo,
} from "../types.ts";
import { ForgejoProvider, nextPage, toRepo } from "./forgejo.ts";
import { NO_ACCOUNT } from "../words.ts";
import { asArray, asString, dig, fail, field, seg, splitFullName, succeed } from "./http.ts";

const NONE = { ok: true, value: [] } as const;

export class ForgeProvider extends ForgejoProvider {
  /** The account is `username` on a forge, not Gitea's `login`. */
  override async whoami(): Promise<ProviderResult<RemoteIdentity>> {
    const result = await this.api.call({ path: "/user" });
    if (!result.ok) return result;
    const login = asString(field(result.value.data, "username"));
    if (login === "") return fail("invalid_response", NO_ACCOUNT);
    return succeed({
      login,
      displayName: asString(field(result.value.data, "displayName")) || login,
      htmlUrl: `${this.webUrl}/${login}`,
    });
  }

  /** The caller's own repositories, in the shape `/user/repos` answers. */
  override async listRepos(cursor?: string): Promise<ProviderResult<Page<RemoteRepo>>> {
    const page = Math.max(1, Number(cursor) || 1);
    const limit = await this.pageSize();
    const result = await this.api.call({ path: "/user/repos", query: { limit, page } });
    if (!result.ok) return result;
    const rows = asArray(result.value.data);
    return succeed({
      items: rows.map(toRepo),
      next: nextPage(result.value.headers, rows.length, limit, page),
    });
  }

  /** One repository, from a forge's own JSON (`ownerName`, `visibility`). */
  override async getRepo(fullName: string): Promise<ProviderResult<RemoteRepo>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}`,
    });
    if (!result.ok) return result;
    const raw = result.value.data;
    const owner = asString(field(raw, "ownerName")) || named.owner;
    const name = asString(field(raw, "name")) || named.name;
    const web = `${this.webUrl}/${owner}/${name}`;
    return succeed(
      toRepo({
        id: field(raw, "id"),
        full_name: `${owner}/${name}`,
        name,
        owner: { login: owner },
        description: field(raw, "description"),
        private: asString(field(raw, "visibility")) !== "public",
        fork: dig(raw, "forkParentId") !== null && dig(raw, "forkParentId") !== undefined,
        default_branch: field(raw, "defaultBranch"),
        clone_url: `${web}.git`,
        html_url: web,
      }),
    );
  }

  override listLabels(): Promise<ProviderResult<readonly RemoteLabel[]>> {
    return Promise.resolve(NONE);
  }

  /** Implements the optional `Provider.listMilestones`; Forgejo has none to override. */
  listMilestones(): Promise<ProviderResult<readonly RemoteMilestone[]>> {
    return Promise.resolve(NONE);
  }

  override listIssues(): Promise<ProviderResult<Page<RemoteIssue>>> {
    return Promise.resolve({ ok: true, value: { items: [], next: null } });
  }
}
