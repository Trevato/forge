import {
  addAppDomain,
  checkAppDomain,
  keepOldRecords,
  listAppDomains,
  removeAppDomain,
} from "../../../actions/domains.ts";
import {
  dnsRefusal,
  DNS_STEPS,
  editAppDomainDns,
} from "../../../actions/domain_dns.ts";
import {
  NO_SUCH_DOMAIN,
  domainAddedText,
  domainRefusalText,
  domainRemovedText,
  domainSaidText,
} from "../../../actions/domain_words.ts";
import { type Answer, good, bad, type Tool, REPO_ARG, repoArg, isAnswer, str } from "../shared.ts";

export const tool: Tool = {
  name: "app_domains",
  doc: "`{ repo, action, host?, records? }`: `list`, `add`, `check` (looks the DNS proof up now), `keep` (`records`: the old DNS records `[{type,name,value,ttl?}]` written down before a cut-over, shown back as `oldRecords` on `list`; `add` takes them too) or `remove` an app's own domains, with the records to publish, as `…/app/domains` answers; or edit its DNS with `dns_proof`, `dns_cut` (answers the records it replaced) or `dns_revert` (`records` `[{type,value,ttl?}]`; verified names only), using the repo's secret DNS_API_TOKEN; an admin of the repository with an admin-scope token",
  description: "App domains: list, add, check, keep, remove; dns_proof, dns_cut, dns_revert.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string" },
      host: { type: "string" },
      records: { type: "array", maxItems: 50 },
    },
  },
  writes: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const action = args["action"];
    const dnsStep = DNS_STEPS.find((step) => `dns_${step}` === action);
    const plain = ["list", "add", "check", "keep", "remove"].includes(String(action));
    if (dnsStep === undefined && !plain)
      return bad("invalid", "action is list, add, check, keep, remove, dns_proof, dns_cut or dns_revert");
    const host = str(args["host"]);
    if (dnsStep !== undefined) {
      if (host === "") return bad("invalid", "host is the domain name");
      const edited = await editAppDomainDns(ctx.app, user, repo, host, dnsStep, args["records"]);
      return edited.ok
        ? good({ says: edited.value.says, removed: edited.value.removed, put: edited.value.put })
        : bad(typeof edited.error === "string" ? edited.error : "left_half", dnsRefusal(edited.error));
    }
    if (action !== "list" && host === "") return bad("invalid", "host is the domain name");
    const refused = (error: string, fallback: string): Answer =>
      error === "not_found"
        ? bad("not_found", "no such app or repository (owner/name)")
        : bad(error, domainRefusalText(error, fallback));
    if (action === "list") {
      const listed = listAppDomains(ctx.app, user, repo);
      return listed.ok
        ? good({ items: listed.value, next_cursor: null })
        : refused(listed.error, NO_SUCH_DOMAIN);
    }
    if (action === "add") {
      const added = addAppDomain(ctx.app, user, repo, host, args["records"]);
      return added.ok
        ? good({ ...added.value, says: domainAddedText(added.value) })
        : refused(added.error, "That domain could not be added.");
    }
    if (action === "keep") {
      const kept = keepOldRecords(ctx.app, user, repo, host, args["records"]);
      return kept.ok ? good(kept.value) : refused(kept.error, NO_SUCH_DOMAIN);
    }
    if (action === "check") {
      const checked = await checkAppDomain(ctx.app, user, repo, host);
      return checked.ok
        ? good({ ...checked.value, says: domainSaidText(checked.value) })
        : refused(checked.error, NO_SUCH_DOMAIN);
    }
    const removed = removeAppDomain(ctx.app, user, repo, host);
    return removed.ok
      ? good({ says: domainRemovedText(host) })
      : refused(removed.error, NO_SUCH_DOMAIN);
  },
};
