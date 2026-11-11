/**
 * Vendor ratings for the disks the forge knows (#10464). Keyed by the exact
 * model string smartctl reports; a model not listed returns `null` — nothing
 * is guessed from a similar name. Ratings are the vendor's published figures
 * (Samsung 980 PRO data sheet: 1 TB, 600 TBW endurance, 5-year limited
 * warranty, composite temperature warning 82 °C, critical 85 °C).
 */

export type DiskSpec = {
  model: string;
  /** Rated endurance, terabytes written (1 TB = 10^12 bytes, as vendors state it). */
  ratedTbw: number;
  warrantyYears: number;
  /** Composite temperature, degrees Celsius. */
  warnTempC: number;
  critTempC: number;
};

const CATALOG: readonly DiskSpec[] = [
  { model: "Samsung SSD 980 PRO 1TB", ratedTbw: 600, warrantyYears: 5, warnTempC: 82, critTempC: 85 },
];

/** The spec for exactly this model, or null when it is not in the catalog. */
export function diskSpec(model: unknown): DiskSpec | null {
  if (typeof model !== "string") return null;
  const found = CATALOG.find((s) => s.model === model);
  return found ? { ...found } : null;
}
