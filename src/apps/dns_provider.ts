/**
 * Editing DNS at the registrar: one adapter (Cloudflare), one operation —
 * replace the address records at a name, or set its TXT — and every record
 * it removed handed back, so the way back is never lost. The credential is
 * not here: the caller opens it by name (`actions/domain_dns.ts`). Every
 * failure is a sentence, never a throw. Plain data in, plain data out.
 */

export type EditableType = "A" | "AAAA" | "CNAME" | "TXT";
export const EDITABLE_TYPES: readonly EditableType[] = ["A", "AAAA", "CNAME", "TXT"];

export interface ZoneRecord {
  readonly type: EditableType;
  readonly name: string;
  readonly value: string;
  /** Seconds; 1 means the provider's automatic TTL. */
  readonly ttl: number;
}

export interface DnsProvider {
  /**
   * Remove every record of `replace` types at `name` and put `put` there.
   * Returns what was removed. On failure the records already put are deleted
   * and the removed ones put back; any that could not be are returned.
   */
  replace(
    name: string,
    replace: readonly EditableType[],
    put: readonly ZoneRecord[],
  ): Promise<
    | { ok: true; removed: ZoneRecord[] }
    // `unrestored`: removed records that could not be put back, the way back.
    | { ok: false; says: string; unrestored: ZoneRecord[] }
  >;
}

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success?: boolean;
  result?: T;
  errors?: { message?: string }[];
}
interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
}

export function cloudflare(token: string, doFetch: typeof fetch = fetch): DnsProvider {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok || json.success === false || json.result === undefined)
      throw new Error(json.errors?.[0]?.message ?? `the registrar answered ${res.status}`);
    return json.result;
  };

  const zoneOf = async (name: string): Promise<string> => {
    const labels = name.split(".");
    for (let at = 0; at < labels.length - 1; at++) {
      const zones = await call<{ id: string }[]>(
        "GET",
        `/zones?name=${encodeURIComponent(labels.slice(at).join("."))}`,
      );
      if (zones[0] !== undefined) return zones[0].id;
    }
    throw new Error("the credential reaches no zone that holds this name");
  };

  const create = (zone: string, r: ZoneRecord) =>
    call<{ id?: string }>("POST", `/zones/${zone}/dns_records`, {
      type: r.type,
      name: r.name,
      content: r.value,
      ttl: r.ttl,
    });

  return {
    async replace(name, replace, put) {
      let zone = "";
      const removed: ZoneRecord[] = [];
      const made: string[] = [];
      try {
        zone = await zoneOf(name);
        const found = await call<CfRecord[]>(
          "GET",
          `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
        );
        const doomed = found.filter(
          (r) => r.name === name && (replace as readonly string[]).includes(r.type),
        );
        for (const r of doomed) {
          await call("DELETE", `/zones/${zone}/dns_records/${r.id}`);
          removed.push({ type: r.type as EditableType, name: r.name, value: r.content, ttl: r.ttl });
        }
        for (const r of put) {
          const c = await create(zone, r);
          if (c.id !== undefined) made.push(c.id);
        }
        return { ok: true, removed };
      } catch (error) {
        const raw = error instanceof Error ? error.message : "the registrar did not answer";
        // A registrar may echo the credential back; it never leaves here.
        const says = token === "" ? raw : raw.split(token).join("…");
        // Undo, best effort: drop what was put, put back what was taken.
        const unrestored: ZoneRecord[] = [];
        if (zone !== "") {
          for (const id of made)
            await call("DELETE", `/zones/${zone}/dns_records/${id}`).catch(() => undefined);
          for (const r of removed) await create(zone, r).catch(() => unrestored.push(r));
        }
        return {
          ok: false,
          says: unrestored.length === 0 ? `DNS was not changed: ${says}.` : `${says}.`,
          unrestored,
        };
      }
    },
  };
}
