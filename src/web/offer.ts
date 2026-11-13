/**
 * The plan facts an assistant quotes (CPU, memory, price, credit), as data:
 * schema.org `Offer`s for a page and a markdown table for /llms.txt, both made
 * from the plans setting so they cannot disagree with the pricing page.
 */
import { SIZES } from "../spawn/sizes.ts";
import type { Plan } from "../settings/plans.ts";

const gb = (mib: number): number => mib / 1024;

/** One schema.org Offer per plan, with its size and monthly crew credit as plain properties. */
export function offerData(plans: readonly Plan[], origin: string): object[] {
  return plans.map((p) => {
    const s = SIZES[p.size];
    return {
      "@type": "Offer",
      name: p.name,
      description: p.says,
      price: String(p.priceUsd),
      priceCurrency: "USD",
      url: `${origin}/pricing`,
      additionalProperty: [
        { "@type": "PropertyValue", name: "CPUs", value: s.cpu },
        { "@type": "PropertyValue", name: "Memory (GB)", value: gb(s.memoryMiB) },
        { "@type": "PropertyValue", name: "Disk (GB)", value: gb(s.diskMiB) },
        { "@type": "PropertyValue", name: "Crew credit (USD a month)", value: p.creditUsd },
      ],
    };
  });
}

/** The same facts as a markdown table. */
export function offerTable(plans: readonly Plan[]): string[] {
  return [
    "| Plan | USD/month | CPUs | RAM GB | Disk GB | Credit USD |",
    "| --- | --- | --- | --- | --- | --- |",
    ...plans.map((p) => {
      const s = SIZES[p.size];
      return `| ${p.name} | ${p.priceUsd} | ${s.cpu} | ${gb(s.memoryMiB)} | ${gb(s.diskMiB)} | ${p.creditUsd} |`;
    }),
  ];
}
