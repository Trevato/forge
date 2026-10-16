/**
 * Cloud providers: what each one's credential looks like, and the read-only
 * calls the forge makes with it. Every call here is a GET, a list, or an
 * identity lookup — nothing creates, changes or deletes. The complete list:
 *
 *   cloudflare    GET  api.cloudflare.com/client/v4/user/tokens/verify, /zones
 *   digitalocean  GET  api.digitalocean.com/v2/account, /projects, /droplets,
 *                      /volumes, /reserved_ips
 *   aws           POST sts.amazonaws.com  Action=GetCallerIdentity (a read),
 *                 POST ec2.us-east-1.amazonaws.com  Action=DescribeVolumes,
 *                      DescribeAddresses (reads, despite the verb)
 *   azure         POST login.microsoftonline.com/<tenant>/oauth2/v2.0/token
 *                      (client-credentials sign-in), GET management.azure.com
 *                      /subscriptions, /disks, /publicIPAddresses
 *   fly           POST api.fly.io/graphql  — `query` documents only
 *   github        GET  api.github.com/user
 *   vercel        GET  api.vercel.com/v2/user
 *   backblaze     GET  api.backblazeb2.com/b2api/v2/b2_authorize_account, then
 *                 GET  <apiUrl>/b2api/v2/b2_list_buckets (apiUrl must be a
 *                      *.backblazeb2.com host)
 *
 * Hosts are fixed here, never taken from input. Providers whose credential
 * has several parts take them joined by `:` — see `shape`.
 */

import { createHmac, createHash } from "node:crypto";
import type { CloudVendor } from "../apps/manifest.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const PROVIDERS = [
  "cloudflare",
  "digitalocean",
  "aws",
  "azure",
  "fly",
  "backblaze",
  "github",
  "vercel",
] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * The `cloud.json` vendor each provider's key is declared under. Total, so no
 * attached key is unreachable: the provider's own name, but AWS and
 * Backblaze B2 are both `s3`.
 */
export const VENDOR_OF: Record<Provider, CloudVendor> = {
  cloudflare: "cloudflare",
  digitalocean: "digitalocean",
  aws: "s3",
  azure: "azure",
  fly: "fly",
  backblaze: "s3",
  github: "github",
  vercel: "vercel",
};

export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

export const LABEL: Record<Provider, string> = {
  cloudflare: "Cloudflare",
  digitalocean: "DigitalOcean",
  aws: "AWS",
  azure: "Azure",
  fly: "Fly.io",
  backblaze: "Backblaze B2",
  github: "GitHub",
  vercel: "Vercel",
};

/** What to paste, per provider, in a sentence. */
export const shape: Record<Provider, string> = {
  cloudflare: "an API token (read-only scope is enough)",
  digitalocean: "a personal access token (read scope is enough)",
  aws: "ACCESS_KEY_ID:SECRET_ACCESS_KEY of a read-only IAM user",
  azure: "TENANT_ID:CLIENT_ID:CLIENT_SECRET of a Reader service principal",
  fly: "a deploy or read-only org token",
  backblaze: "KEY_ID:APPLICATION_KEY with read-only capabilities",
  github: "a fine-grained personal access token with read-only repository access",
  vercel: "an access token scoped to one team",
};

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Verified {
  /** One sentence: what the credential can see. */
  readonly summary: string;
  /** True when the provider's own answer shows the credential can write. */
  readonly canWrite: boolean | null;
}

export interface Finding {
  readonly title: string;
  readonly body: string;
  /** Estimated saving, USD per month. */
  readonly saving: number;
}

const FAIL = "The provider did not accept that credential.";

async function json(f: Fetch, url: string, init: RequestInit = {}): Promise<any> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return await res.json();
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Split a multi-part credential into exactly `n` non-empty parts. */
function parts(value: string, n: number): string[] | undefined {
  const p = value.split(":");
  return p.length === n && p.every((x) => x !== "" && /^[\x21-\x7e]+$/.test(x))
    ? p
    : undefined;
}

// ---- AWS Signature V4 (query API, POST form body) ----

async function awsCall(
  f: Fetch,
  key: string,
  secret: string,
  service: string,
  host: string,
  region: string,
  body: string,
): Promise<string> {
  const now = new Date();
  const amz = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const hmac = (k: Buffer | string, s: string) =>
    createHmac("sha256", k).update(s).digest();
  const headers = `content-type:application/x-www-form-urlencoded\nhost:${host}\nx-amz-date:${amz}\n`;
  const signed = "content-type;host;x-amz-date";
  const canonical = `POST\n/\n\n${headers}\n${signed}\n${hash(body)}`;
  const scope = `${day}/${region}/${service}/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${hash(canonical)}`;
  const k = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
  const sig = createHmac("sha256", k).update(sts).digest("hex");
  const res = await f(`https://${host}/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-amz-date": amz,
      authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${host} answered ${res.status}`);
  return await res.text();
}

const tag = (xml: string, t: string): string[] =>
  [...xml.matchAll(new RegExp(`<${t}>([^<]*)</${t}>`, "g"))].map((m) => m[1]!);

// ---- Azure ----

async function azureToken(f: Fetch, value: string): Promise<string | undefined> {
  const p = parts(value, 3);
  if (!p || !/^[0-9a-zA-Z.-]+$/.test(p[0]!)) return undefined;
  const res = await json(
    f,
    `https://login.microsoftonline.com/${p[0]}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: p[1]!,
        client_secret: p[2]!,
        scope: "https://management.azure.com/.default",
      }),
    },
  );
  return typeof res.access_token === "string" ? res.access_token : undefined;
}

const ARM = "https://management.azure.com";

// ---- Fly ----

const fly = (f: Fetch, token: string, query: string) =>
  json(f, "https://api.fly.io/graphql", {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });

// ---- Backblaze ----

async function b2(f: Fetch, value: string) {
  const p = parts(value, 2);
  if (!p) return undefined;
  const auth = await json(
    f,
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${p[0]}:${p[1]}`).toString("base64")}`,
      },
    },
  );
  const api = new URL(String(auth.apiUrl));
  if (api.protocol !== "https:" || !api.hostname.endsWith(".backblazeb2.com"))
    throw new Error("unexpected B2 api host");
  return { auth, api: api.origin };
}

/** Sign in read-only and say what the credential can see. Never throws. */
export async function verify(
  provider: Provider,
  value: string,
  f: Fetch = fetch,
): Promise<Result<Verified, string>> {
  try {
    switch (provider) {
      case "cloudflare": {
        const v = await json(f, "https://api.cloudflare.com/client/v4/user/tokens/verify", {
          headers: bearer(value),
        }).catch(() => undefined);
        const z = await json(f, "https://api.cloudflare.com/client/v4/zones?per_page=50", {
          headers: bearer(value),
        });
        const names: string[] = (z.result ?? []).map((r: any) => String(r.name));
        const shown = names.slice(0, 5).join(", ");
        return ok({
          summary: `Cloudflare token${v?.result?.status ? ` (${v.result.status})` : ""} sees ${plural(names.length, "zone")}${shown ? `: ${shown}` : ""}; the API does not say which permissions it holds.`,
          canWrite: null,
        });
      }
      case "digitalocean": {
        const h = bearer(value);
        const a = await json(f, "https://api.digitalocean.com/v2/account", { headers: h });
        const p = await json(f, "https://api.digitalocean.com/v2/projects", { headers: h }).catch(() => undefined);
        const d = await json(f, "https://api.digitalocean.com/v2/droplets?per_page=1", { headers: h }).catch(() => undefined);
        return ok({
          summary: `DigitalOcean account ${a.account?.email ?? "?"} (${a.account?.status ?? "?"}) has ${p ? plural(p.projects?.length ?? 0, "project") : "projects hidden from this token"} and ${d ? plural(d.meta?.total ?? 0, "droplet") : "droplets hidden from this token"}; DigitalOcean does not expose a token's scope.`,
          canWrite: null,
        });
      }
      case "aws": {
        const p = parts(value, 2);
        if (!p) return err("An AWS credential is ACCESS_KEY_ID:SECRET_ACCESS_KEY.");
        const x = await awsCall(f, p[0]!, p[1]!, "sts", "sts.amazonaws.com", "us-east-1",
          "Action=GetCallerIdentity&Version=2011-06-15");
        return ok({
          summary: `AWS identity ${tag(x, "Arn")[0] ?? "?"} in account ${tag(x, "Account")[0] ?? "?"}; AWS shows who the key is, not what its policy allows.`,
          canWrite: null,
        });
      }
      case "azure": {
        const t = await azureToken(f, value);
        if (!t) return err("An Azure credential is TENANT_ID:CLIENT_ID:CLIENT_SECRET.");
        const s = await json(f, `${ARM}/subscriptions?api-version=2022-12-01`, { headers: bearer(t) });
        const subs: string[] = (s.value ?? []).map((r: any) => String(r.displayName));
        return ok({
          summary: `Azure principal sees ${plural(subs.length, "subscription")}${subs.length ? `: ${subs.slice(0, 5).join(", ")}` : ""}; roles are not read.`,
          canWrite: null,
        });
      }
      case "fly": {
        const r = await fly(f, value, "query { organizations { nodes { slug } } apps { nodes { name } } }");
        if (r.errors) return err(FAIL);
        const orgs = (r.data?.organizations?.nodes ?? []).map((o: any) => String(o.slug));
        return ok({
          summary: `Fly token sees ${plural(orgs.length, "organization")}${orgs.length ? ` (${orgs.slice(0, 5).join(", ")})` : ""} and ${plural(r.data?.apps?.nodes?.length ?? 0, "app")}.`,
          canWrite: null,
        });
      }
      case "github": {
        const u = await json(f, "https://api.github.com/user", {
          headers: { ...bearer(value), accept: "application/vnd.github+json", "user-agent": "forge" },
        });
        return ok({
          summary: `GitHub token belongs to ${String(u.login ?? "?").slice(0, 80)}; GitHub does not say what a fine-grained token may write here.`,
          canWrite: null,
        });
      }
      case "vercel": {
        const u = await json(f, "https://api.vercel.com/v2/user", { headers: bearer(value) });
        return ok({
          summary: `Vercel token belongs to ${String(u.user?.username ?? "?").slice(0, 80)}; Vercel does not expose a token's scope.`,
          canWrite: null,
        });
      }
      case "backblaze": {
        const c = await b2(f, value);
        if (!c) return err("A Backblaze credential is KEY_ID:APPLICATION_KEY.");
        const caps: string[] = c.auth.allowed?.capabilities ?? [];
        const writes = caps.some((x) => /^(write|delete|share|bypass)/i.test(x));
        const l = await json(f, `${c.api}/b2api/v2/b2_list_buckets`, {
          method: "POST",
          headers: { authorization: String(c.auth.authorizationToken), "content-type": "application/json" },
          body: JSON.stringify({ accountId: c.auth.accountId }),
        });
        return ok({
          summary: `Backblaze key sees ${plural(l.buckets?.length ?? 0, "bucket")}; its own capabilities: ${caps.join(", ") || "none"}${writes ? " — it CAN write" : " — read-only"}.`,
          canWrite: writes,
        });
      }
    }
  } catch (e) {
    return err(e instanceof Error && /answered 40[13]|answered 400/.test(e.message) ? FAIL : `Could not verify: ${e instanceof Error ? e.message : "failed"}`);
  }
}

/** Read-only audit: findings with estimated monthly savings. Changes nothing. */
export async function audit(
  provider: Provider,
  value: string,
  f: Fetch = fetch,
): Promise<Result<Finding[], string>> {
  const found: Finding[] = [];
  const add = (title: string, detail: string, saving: number) =>
    found.push({
      title,
      body: `${detail}\n\nEstimated saving: about ${money(saving)} a month.\n\nFound by a read-only cloud audit; nothing was changed. Check before you delete: the forge cannot see what depends on it.`,
      saving,
    });
  try {
    switch (provider) {
      case "digitalocean": {
        const h = bearer(value);
        const base = "https://api.digitalocean.com/v2";
        const v = await json(f, `${base}/volumes?per_page=200`, { headers: h });
        for (const x of v.volumes ?? [])
          if ((x.droplet_ids ?? []).length === 0)
            add(`DigitalOcean: unattached volume ${x.name}`, `Volume ${x.name} (${x.size_gigabytes} GB, ${x.region?.slug}) is attached to no droplet.`, x.size_gigabytes * 0.1);
        const d = await json(f, `${base}/droplets?per_page=200`, { headers: h });
        for (const x of d.droplets ?? [])
          if (x.status === "off")
            add(`DigitalOcean: powered-off droplet ${x.name}`, `Droplet ${x.name} (${x.size_slug}) is off but still billed at its full size price.`, Number(x.size?.price_monthly ?? 0));
        const r = await json(f, `${base}/reserved_ips?per_page=200`, { headers: h }).catch(() => ({}));
        for (const x of r.reserved_ips ?? [])
          if (!x.droplet) add(`DigitalOcean: unassigned reserved IP ${x.ip}`, `Reserved IP ${x.ip} points at no droplet.`, 4);
        break;
      }
      case "aws": {
        const p = parts(value, 2);
        if (!p) return err("An AWS credential is ACCESS_KEY_ID:SECRET_ACCESS_KEY.");
        const host = "ec2.us-east-1.amazonaws.com";
        const call = (a: string) => awsCall(f, p[0]!, p[1]!, "ec2", host, "us-east-1", `Action=${a}&Version=2016-11-15`);
        const vols = await call("DescribeVolumes");
        for (const m of vols.matchAll(/<item>(?:(?!<\/item>)[\s\S])*?<volumeId>([^<]+)<\/volumeId>(?:(?!<\/item>)[\s\S])*?<size>(\d+)<\/size>(?:(?!<\/item>)[\s\S])*?<status>available<\/status>/g))
          add(`AWS: unattached volume ${m[1]}`, `EBS volume ${m[1]} (${m[2]} GiB, us-east-1) is available, attached to no instance.`, Number(m[2]) * 0.08);
        const addr = await call("DescribeAddresses");
        for (const m of addr.matchAll(/<item>((?:(?!<\/item>)[\s\S])*?)<\/item>/g))
          if (!/<associationId>/.test(m[1]!))
            add(`AWS: unassociated Elastic IP ${tag(m[1]!, "publicIp")[0] ?? "?"}`, `Elastic IP ${tag(m[1]!, "publicIp")[0] ?? "?"} (us-east-1) is associated with nothing.`, 3.65);
        break;
      }
      case "cloudflare": {
        const z = await json(f, "https://api.cloudflare.com/client/v4/zones?per_page=50", { headers: bearer(value) });
        for (const x of z.result ?? [])
          if (x.status !== "active")
            add(`Cloudflare: zone ${x.name} never went active`, `Zone ${x.name} is "${x.status}": its nameservers were never switched, so its DNS records are not serving anything.`, 0);
        break;
      }
      case "azure": {
        const t = await azureToken(f, value);
        if (!t) return err("An Azure credential is TENANT_ID:CLIENT_ID:CLIENT_SECRET.");
        const s = await json(f, `${ARM}/subscriptions?api-version=2022-12-01`, { headers: bearer(t) });
        for (const sub of s.value ?? []) {
          const id = encodeURIComponent(String(sub.subscriptionId));
          const disks = await json(f, `${ARM}/subscriptions/${id}/providers/Microsoft.Compute/disks?api-version=2023-04-02`, { headers: bearer(t) });
          for (const x of disks.value ?? [])
            if (x.properties?.diskState === "Unattached")
              add(`Azure: unattached disk ${x.name}`, `Disk ${x.name} (${x.properties.diskSizeGB} GB, ${x.location}) in ${sub.displayName} is unattached.`, x.properties.diskSizeGB * 0.05);
          const ips = await json(f, `${ARM}/subscriptions/${id}/providers/Microsoft.Network/publicIPAddresses?api-version=2023-05-01`, { headers: bearer(t) });
          for (const x of ips.value ?? [])
            if (!x.properties?.ipConfiguration)
              add(`Azure: unassociated public IP ${x.name}`, `Public IP ${x.name} in ${sub.displayName} is associated with nothing.`, 3.65);
        }
        break;
      }
      case "fly": {
        const r = await fly(f, value, "query { apps { nodes { name volumes { nodes { name sizeGb attachedMachine { id } } } } } }");
        if (r.errors) return err(FAIL);
        for (const a of r.data?.apps?.nodes ?? [])
          for (const v of a.volumes?.nodes ?? [])
            if (!v.attachedMachine)
              add(`Fly: unattached volume ${v.name} in ${a.name}`, `Volume ${v.name} (${v.sizeGb} GB) of app ${a.name} is attached to no machine.`, v.sizeGb * 0.15);
        break;
      }
      case "github":
      case "vercel":
        // Nothing to audit for cost; the token is only verified.
        break;
      case "backblaze":
        // Bucket size needs a file listing per bucket; not attempted.
        break;
    }
  } catch (e) {
    return err(`Audit stopped: ${e instanceof Error ? e.message : "failed"}`);
  }
  return ok(found.slice(0, 50));
}
