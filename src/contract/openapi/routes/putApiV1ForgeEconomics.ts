import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/forge/economics",
  summary: "Set the profit slider's position, the margin on crew spend, the label that selects owned nodes and/or the operator's prices (ownedMonthUsd, ownedSlots, cloudHourUsd, storageGbMonthUsd; and the list prices awakePriceHourUsd, storagePriceGbMonthUsd: US dollars, at most two decimals, non-negative); a field left out keeps its value, each change is kept (a person admin's token, admin scope)",
  auth: true,
  body: {
    position: "whole number 0-100",
    marginPct: "whole number 0-500",
    ownedNodeLabel: "node label key=value, e.g. plat.sh/site=vxrail",
    ownedMonthUsd: "US dollars per month for the owned box, 0-1000000, at most two decimals",
    ownedSlots: "whole number of app-slots the owned box holds, 0-10000",
    cloudHourUsd: "US dollars per awake-hour on cloud, 0-1000000, at most two decimals",
    storageGbMonthUsd: "US dollars per GB-month kept, 0-1000000, at most two decimals",
    awakePriceHourUsd: "list price a customer pays, US dollars per awake-hour, 0-1000000, at most two decimals",
    storagePriceGbMonthUsd: "list price a customer pays, US dollars per GB-month kept, 0-1000000, at most two decimals",
  },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    not_admin: "the person's role may not administer the forge (403)",
    bad_position: "position is not a whole number from 0 to 100 (422)",
    bad_margin: "marginPct is not a whole number from 0 to 500 (422)",
    bad_price: "a price is not US dollars from 0 to 1000000.00 with at most two decimals (422)",
    bad_slots: "ownedSlots is not a whole number from 0 to 10000 (422)",
    bad_label: "ownedNodeLabel is not a node label as key=value (422)",
  },
};
