/**
 * Where a forge can be put, and what each place can and cannot hold (#8697).
 * A forge is a Bun process, SQLite and a disk that outlives the process, so a
 * target needs a machine and a volume. Prices are list prices for the
 * smallest size that runs a forge, USD a month, as last read; the page says
 * so, and the owner's own bill is the truth.
 */

export type TargetId = "digitalocean" | "aws" | "azure" | "cloudflare" | "vercel";

export interface Target {
  readonly id: TargetId;
  readonly label: string;
  /** `first` deploys today; `planned` has a machine and a volume but no driver yet; `refused` cannot hold a forge. */
  readonly status: "first" | "planned" | "refused";
  readonly runs: string;
  readonly cost: string;
  readonly refused: string;
}

export const TARGETS: readonly Target[] = [
  {
    id: "digitalocean",
    label: "DigitalOcean",
    status: "first",
    runs: "One droplet (Ubuntu, Bun from the pinned source) with one block volume mounted as FORGE_APP_DATA. Replacing the droplet keeps the volume, so a version change never touches the data.",
    cost: "about $12 (s-1vcpu-2gb) + $1.20 (10 GiB volume)",
    refused: "Nothing the forge needs is refused; the token must be able to create droplets and volumes, which DigitalOcean cannot narrow further.",
  },
  {
    id: "aws",
    label: "AWS",
    status: "planned",
    runs: "One EC2 instance (t4g.small) with one EBS gp3 volume, same boot script. Needs SigV4 signing for RunInstances, which providers.ts already does for reads.",
    cost: "about $12 + $0.80 (10 GiB gp3) + a public IPv4 address, about $3.65",
    refused: "A long-lived access key with EC2 write is the broadest credential of the three; the driver will ask for a role scoped to one tag, and is not written yet.",
  },
  {
    id: "azure",
    label: "Azure",
    status: "planned",
    runs: "One VM (B1ms) with one managed disk, through a service principal with Contributor on one resource group.",
    cost: "about $15 + $1 (10 GiB standard SSD) + a public IP, about $3.65",
    refused: "Not written yet: it needs a resource group, a network and a public IP created first, so it is three calls more than the droplet.",
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    status: "refused",
    runs: "Workers and Durable Objects hold state, but not as a file system a Bun process can open. Cloudflare Containers run a container, with a disk that is wiped when the container sleeps or is replaced.",
    cost: "Workers Paid, $5 a month minimum, plus container time",
    refused: "A forge keeps bare git repositories and SQLite on a disk that survives restarts. Cloudflare offers no such volume to a container, so the forge refuses to put one there rather than lose data quietly.",
  },
  {
    id: "vercel",
    label: "Vercel",
    status: "refused",
    runs: "Functions and Sandboxes: short-lived, one request or one task, with a scratch disk that does not persist.",
    cost: "Pro from $20 a seat a month",
    refused: "No long-running process and no persistent disk, so a forge cannot live there. Vercel can host an app a forge ships, which is a different thing.",
  },
];

export const target = (id: string): Target | undefined => TARGETS.find((t) => t.id === id);
