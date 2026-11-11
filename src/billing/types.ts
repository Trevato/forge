/**
 * What a forge is entitled to (#11134): plain data. There is no payment
 * processor; an admin's hand grant is the only thing that writes one.
 */

export type EntitlementStatus = "active" | "grace" | "none";

export type Entitlement = {
  forge: string;
  plan: string;
  status: EntitlementStatus;
  periodEnd?: number;
  source: string;
};
