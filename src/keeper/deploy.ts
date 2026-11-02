/**
 * The release keeper's hands on the cluster (#7557): read the image the
 * forge's Deployment runs, set it to a named image, and say whether a roll
 * to an image has finished. That is all. There is no "undo to previous":
 * on 2026-10-27 a `rollout undo` put the broken version back for two
 * minutes, because "previous" is whatever the controller last held. A
 * rollback here sets the image recorded before the cut, by name
 * (`keeper/rollback.ts`).
 *
 * Spoken over `fetch` to the kube API with the pod's service account
 * (`cluster/jobs.ts` `serviceAccount`), as a strategic-merge patch of the
 * one container's image, the same request `kubectl set image` sends.
 */

import type { Credentials } from "../cluster/jobs.ts";

export interface Deployer {
  /** The image the Deployment's forge container names now. */
  image(): Promise<string>;
  /** Name this image on the forge container; the Deployment rolls to it with surge. */
  setImage(image: string): Promise<void>;
  /** The reference that names `version` at `sha` (a swap names a tree, not a tag); the keeper falls back to `imageAt`. */
  refFor?(version: string, sha: string): string;
  /** Why `sha` cannot be released by this deployer, checked before anything is cut; undefined when it can. */
  admits?(sha: string): Promise<string | undefined>;
  /** `version` read well under load and is the known good: keep it for a restart. */
  verified?(version: string): void;
}

/** An image reference: registry/path:tag or @digest, no space, no flag. */
const IMAGE = /^[a-z0-9][a-z0-9._\-/:]{0,254}(@sha256:[a-f0-9]{64})?$/;
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const isImage = (s: string): boolean => IMAGE.test(s) && !s.includes("..");

/** The image `image` names with its tag replaced by `version`: `reg:5000/o/forge:0.7.1` → `reg:5000/o/forge:0.7.2`. */
export function imageAt(image: string, version: string): string {
  const repo = image.split("@")[0]!;
  const slash = repo.lastIndexOf("/");
  const colon = repo.lastIndexOf(":");
  return `${colon > slash ? repo.slice(0, colon) : repo}:${version}`;
}

/** The tag an image names, or "" when it names none. */
export function tagOf(image: string): string {
  const repo = image.split("@")[0]!;
  const colon = repo.lastIndexOf(":");
  return colon > repo.lastIndexOf("/") ? repo.slice(colon + 1) : "";
}

type Fetch = (url: string, init: RequestInit & { tls?: { ca: string } }) => Promise<Response>;

interface DeploymentJson {
  metadata?: { generation?: number };
  spec?: { replicas?: number; template?: { spec?: { containers?: { name?: string; image?: string }[] } } };
  status?: { observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number };
}

export function kubeDeployer(input: {
  credentials: Credentials;
  deployment: string;
  container: string;
  fetch?: Fetch;
}): Deployer {
  const { credentials: c, deployment, container } = input;
  if (!LABEL.test(deployment) || !LABEL.test(container) || !LABEL.test(c.namespace))
    throw new Error("deployment, container and namespace must be DNS labels");
  const call = input.fetch ?? (fetch as unknown as Fetch);
  const url = `${c.server}/apis/apps/v1/namespaces/${c.namespace}/deployments/${deployment}`;
  const auth = { authorization: `Bearer ${c.token}` };
  const tls = c.ca === undefined ? {} : { tls: { ca: c.ca } };
  const read = async (): Promise<DeploymentJson> => {
    const res = await call(url, { headers: auth, ...tls });
    if (!res.ok) throw new Error(`reading deployment ${deployment}: HTTP ${res.status}`);
    return (await res.json()) as DeploymentJson;
  };
  const imageOf = (d: DeploymentJson): string => {
    const found = d.spec?.template?.spec?.containers?.find((k) => k.name === container)?.image;
    if (found === undefined) throw new Error(`deployment ${deployment} has no container ${container}`);
    return found;
  };
  return {
    image: async () => imageOf(await read()),
    async setImage(image) {
      if (!isImage(image)) throw new Error("not an image reference");
      const res = await call(url, {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/strategic-merge-patch+json" },
        body: JSON.stringify({ spec: { template: { spec: { containers: [{ name: container, image }] } } } }),
        ...tls,
      });
      if (!res.ok) throw new Error(`setting ${deployment} to ${image}: HTTP ${res.status}`);
    },
  };
}
