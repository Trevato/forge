/** The UTC day key (`YYYY-MM-DD`) that timing rows are filed under; shared by the web and perf layers. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
