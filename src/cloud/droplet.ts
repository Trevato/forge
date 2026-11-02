/**
 * DigitalOcean, the first target (#8697): the requests that put a pinned
 * forge on a droplet with a volume, and replace the droplet on an explicit
 * Update while the volume — the forge's data — stays. Plain data in, plain
 * data out: the caller owns the token and the fetch. The token travels in an
 * Authorization header over HTTPS, never on argv, and the boot script holds no
 * secret at all: the new forge's first visitor claims it at /first-admin.
 *
 * Calls (DigitalOcean API v2): POST /volumes, POST /droplets, DELETE /droplets/{id}, GET /droplets/{id}
 * (the public IPv4 the droplet was given, read back after it boots).
 * The caller records each id the moment it exists (`onVolume`, `onDeleted`),
 * so a failure half-way leaves a row a retry can finish, never an orphan.
 */

import type { Fetch } from "./providers.ts";
import type { Pinned } from "../core/pinned.ts";

const API = "https://api.digitalocean.com/v2";
export const REGION = "nyc3";
export const SIZE = "s-1vcpu-2gb";
/** The Bun the droplet installs: it moves only when this line does, in a pull, so the runtime is pinned as the forge is. */
export const BUN_VERSION = "1.3.14";

/** cloud-config for the droplet: Bun, the pinned source at the pinned version, a systemd unit. */
export function bootConfig(p: Pick<Pinned, "name" | "source" | "version" | "config">): string {
  // DigitalOcean mounts a volume at /mnt/<its name, dashes as underscores>.
  const data = `/mnt/${volumeName(p.name).replace(/-/g, "_")}`;
  const env = Object.entries({ ...p.config, FORGE_APP_DATA: data })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  // Every interpolated value is validated in core/pinned.ts (version, source, config) or by NAME.
  return `#cloud-config
write_files:
  - path: /etc/forge/env
    permissions: "0600"
    content: ${JSON.stringify(env + "\n")}
  - path: /etc/systemd/system/forge.service
    content: |
      [Unit]
      Description=forge ${p.name} pinned at ${p.version}
      After=network-online.target
      [Service]
      EnvironmentFile=/etc/forge/env
      WorkingDirectory=/opt/forge
      ExecStart=/root/.bun/bin/bun run src/main.ts
      Restart=on-failure
      [Install]
      WantedBy=multi-user.target
runcmd:
  - curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  - git clone ${p.source} /opt/forge
  - git -C /opt/forge checkout --detach ${p.version}
  - systemctl enable --now forge.service
`;
}

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function call(f: Fetch, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await f(`${API}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`api.digitalocean.com answered ${res.status}`);
  return res.status === 204 ? {} : await res.json();
}

const volumeName = (name: string) => `forge-${name}-data`;

function createDroplet(f: Fetch, token: string, p: Pinned, volumeId: string) {
  return call(f, token, "POST", "/droplets", {
    name: `forge-${p.name}`,
    region: REGION,
    size: SIZE,
    image: "ubuntu-24-04-x64",
    volumes: [volumeId],
    user_data: bootConfig(p),
    tags: ["forge-pinned"],
  });
}

/**
 * Volume first, then the droplet that mounts it. A volume a failed earlier try
 * made (`have`) is reused; a new one is recorded through `onVolume` before the
 * droplet is asked for. Returns the ids to keep.
 */
export async function provision(
  f: Fetch, token: string, p: Pinned, hooks: { have?: string; onVolume(id: string): void },
): Promise<{ remote: string; volume: string }> {
  let volume = hooks.have ?? "";
  if (volume === "") {
    const v = await call(f, token, "POST", "/volumes", {
      name: volumeName(p.name), region: REGION, size_gigabytes: 10, filesystem_type: "ext4",
    });
    volume = String(v.volume?.id ?? "");
    if (!volume) throw new Error("DigitalOcean made no volume");
    hooks.onVolume(volume);
  }
  const d = await createDroplet(f, token, p, volume);
  return { remote: String(d.droplet?.id ?? ""), volume };
}

/**
 * An explicit Update or rollback: delete the old droplet, start a new one on
 * the same volume. A droplet already gone (404, or none recorded after a failed
 * create) counts as deleted, and `onDeleted` clears the recorded id at once, so
 * a retry after a failed create does not delete twice.
 */
export async function replace(f: Fetch, token: string, p: Pinned, hooks: { onDeleted(): void }): Promise<{ remote: string }> {
  if (p.volume === "") throw new Error("this forge has no volume to keep");
  if (p.remote !== "") {
    if (!/^\d+$/.test(p.remote)) throw new Error("this forge has no droplet to replace");
    try {
      await call(f, token, "DELETE", `/droplets/${p.remote}`);
    } catch (e) {
      if (!(e instanceof Error && e.message.endsWith("answered 404"))) throw e;
    }
    hooks.onDeleted();
  }
  const d = await createDroplet(f, token, p, p.volume);
  return { remote: String(d.droplet?.id ?? "") };
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Read the droplet back: its status and public IPv4 (empty while none is assigned). Only a well-formed address is returned. */
export async function readDroplet(f: Fetch, token: string, remote: string): Promise<{ status: string; address: string }> {
  if (!/^\d+$/.test(remote)) throw new Error("this forge has no droplet to read");
  const d = (await call(f, token, "GET", `/droplets/${remote}`)).droplet;
  const v4: unknown[] = Array.isArray(d?.networks?.v4) ? d.networks.v4 : [];
  const pub = v4.find((n: any) => n?.type === "public" && typeof n.ip_address === "string" && IPV4.test(n.ip_address)) as { ip_address: string } | undefined;
  return { status: String(d?.status ?? ""), address: pub?.ip_address ?? "" };
}
