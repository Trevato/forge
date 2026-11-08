import { testDestination, type DestinationInput } from "../../../actions/destination.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "backups_test",
  doc: "`{ endpoint?, bucket?, region?, accessKey?, secretKey? }`: list the snapshot bucket as the Backups page's Test button does (blank fields test the destination in effect); a forge admin's, with an admin token; answers `{ reached, says }`, never a key",
  description: "Test the snapshot destination.",
  inputSchema: { type: "object" },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const field = (k: string): string | undefined => {
      const v = args[k];
      return v === undefined ? "" : typeof v === "string" ? v.trim() : undefined;
    };
    const input = {
      endpoint: field("endpoint"),
      bucket: field("bucket"),
      region: field("region"),
      accessKey: field("accessKey"),
      secretKey: field("secretKey"),
    };
    if (Object.values(input).some((v) => v === undefined)) return bad("invalid", "send the fields as strings");
    const said = await testDestination(ctx.app, user, input as DestinationInput);
    if (!said.ok) return bad("forbidden", "the snapshot destination is a forge admin's");
    return good({ reached: said.value.startsWith("Reached"), says: said.value });
  },
};
