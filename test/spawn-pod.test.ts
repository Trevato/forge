import { expect, test } from "bun:test";
import { parseEgressBlocks, parsePodLimits, renderPod } from "../src/spawn/pod.ts";

const base = { name: "ada", image: "forge:1", egress: ["93.184.216.34"] };
const rendered = () => {
  const r = renderPod(base);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const kind = (k: string) => rendered().objects.filter((o) => o.kind === k);

test("namespace is forge-child-<name> and every object lives in it", () => {
  const r = rendered();
  expect(r.namespace).toBe("forge-child-ada");
  for (const o of r.objects) if (o.kind !== "Namespace") expect((o.metadata as any).namespace).toBe("forge-child-ada");
  expect(r.objects.map((o) => o.kind)).toEqual([
    "Namespace", "ResourceQuota", "PersistentVolumeClaim", "Deployment", "Service", "NetworkPolicy", "NetworkPolicy",
  ]);
});

test("deployment has no token, runs as 10001, mounts no secrets", () => {
  const spec = (kind("Deployment")[0] as any).spec.template.spec;
  expect(spec.automountServiceAccountToken).toBe(false);
  expect(spec.securityContext.runAsUser).toBe(10001);
  expect(JSON.stringify(spec)).not.toContain("secret");
  expect(spec.volumes.some((v: any) => v.name === "tmp" && v.emptyDir)).toBe(true);
});

test("default deny covers both directions; egress is DNS and 443 to given blocks", () => {
  const [deny, allow] = kind("NetworkPolicy") as any[];
  expect(deny.spec.podSelector).toEqual({});
  expect(deny.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  expect(deny.spec.egress).toBeUndefined();
  expect(deny.spec.ingress).toBeUndefined();
  expect(allow.spec.egress[0].ports.map((p: any) => p.port)).toEqual([53, 53]);
  expect(allow.spec.egress[1].to).toEqual([{ ipBlock: { cidr: "93.184.216.34/32" } }]);
  expect(allow.spec.egress[1].ports).toEqual([{ protocol: "TCP", port: 443 }]);
});

test("limits default to 8 CPU / 16 GiB / 50 GiB and land in quota and PVC", () => {
  expect(parsePodLimits(undefined)).toEqual({ ok: true, value: { cpu: 8, memoryGiB: 16, diskGiB: 50 } });
  const q = (kind("ResourceQuota")[0] as any).spec.hard;
  expect(q["limits.cpu"]).toBe("8");
  expect(q["limits.memory"]).toBe("16Gi");
  expect((kind("PersistentVolumeClaim")[0] as any).spec.resources.requests.storage).toBe("50Gi");
});

test("limits accept whole numbers up to 64 / 256 / 2048 only", () => {
  expect(parsePodLimits({ cpu: 64, memoryGiB: 256, diskGiB: 2048 }).ok).toBe(true);
  for (const bad of [{ cpu: 65 }, { memoryGiB: 257 }, { diskGiB: 2049 }, { cpu: 0 }, { cpu: 1.5 }, { cpu: "4" }, [], 3]) {
    expect(parsePodLimits(bad).ok).toBe(false);
  }
});

test("non-public, IPv6 and unparseable addresses fail the render", () => {
  for (const bad of [
    "10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.0.1", "172.16.0.0/12", "192.168.1.1", "0.0.0.0/0",
    "0.0.0.0", "::1", "2001:db8::/32", "nope", "1.2.3", "1.2.3.4/33", "01.2.3.4", "93.184.216.1/24", "256.1.1.1",
  ]) {
    expect(renderPod({ ...base, egress: [bad] }).ok).toBe(false);
  }
});

test("a block overlapping a denied range on the shorter prefix is denied", () => {
  expect(parseEgressBlocks(["11.0.0.0/7"]).ok).toBe(false);
  expect(parseEgressBlocks(["8.0.0.0/5"]).ok).toBe(false);
  expect(parseEgressBlocks(["12.0.0.0/6"]).ok).toBe(true);
  expect(parseEgressBlocks(["93.184.216.0/24"])).toEqual({ ok: true, value: ["93.184.216.0/24"] });
});

test("bad names and images are refused", () => {
  for (const name of ["", "Ada", "-a", "a-", "a b", "a/../b", "x".repeat(41)]) {
    expect(renderPod({ ...base, name }).ok).toBe(false);
  }
  expect(renderPod({ ...base, image: "x\ny" }).ok).toBe(false);
});
