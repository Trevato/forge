import { test } from "bun:test";
import { confirmAction } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

test("confirmAction: a plain link to the confirm page", () => {
  expectAccessible(confirmAction({ action: "/x/delete", verb: "Delete" }));
  expectAccessible(confirmAction({ action: "/x/delete", verb: "Delete", label: "Delete app notes" }));
});
