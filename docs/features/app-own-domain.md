# An app's own domain: cut-over and the way back

The step of a move that can strand a
shop (`platform-app-move.md`). The forge serves a verified name
and its proxy fetches the certificate; it never writes DNS, so the revert is
the owner's records, put back by hand in one edit. In order:

1. **Write the old records down first.** Every record at the name (A, AAAA,
   CNAME, ALIAS, and the TTL of each) as the old host serves them today,
   in the migration issue. This list is the way back; the forge cannot read
   it for you after the cut.
2. **Add the name** (Settings → App → Domains, `app_domains` `add`, or
   `POST …/app/domains`). The answer lists the TXT proof and the CNAME or
   ALIAS to publish. Publish the **TXT only**; the old A/CNAME stays.
3. **Check** (`check`). The sentence says verified, or what is missing. The
   old site still answers: nothing has moved. `GET /__forge/domains/ask?domain=<host>`
   answering 200 is what lets the proxy issue the certificate on the first
   request (docs/APPS.md, _Your own domain_). On a verified name the check
   also asks the name for its certificate over TLS and appends the expiry to
   the sentence (`Certificate valid until …`, or expired / due within 14
   days, or not read yet). The proxy renews on its own; this is where a
   failed renewal shows. It updates when someone presses Check.
4. **Cut:** replace the old A/CNAME with the CNAME/ALIAS the forge gave. The
   first request to the new name pays for issuing the certificate (a second
   or two); request it once yourself, over https, before telling anyone.
5. **Revert, one step:** put the step-1 records back. Traffic returns to the old
   host as each resolver's cache of the new record expires, so keep the TTL
   low (`platform-app-move.md`, §6) until the shop is settled.
   The forge keeps answering at the name until the domain is removed
   (`remove`); removing it is only tidiness once DNS no longer points here,
   and the old host's certificate was never touched.

Left out, on purpose: the forge does not edit DNS at a registrar (#11717),
or store the old records for you
(#11719). This closes #11700 as a runbook over a feature that already ships,
not as new code.

## What keeps these claims true

All in `test/app-domains.test.ts`:
- the ask endpoint answers 200 only for a verified host (also with case and a
  trailing dot) and 404 for an unverified, unknown or missing name: "verified, the forge serves the
  app at the host and every URL follows";
- before verification the forge answers for itself and the ask says 404:
  "before verification the forge answers for itself at the host";
- removal makes the host unknown again and the ask 404: "removal makes the
  host unknown again".
