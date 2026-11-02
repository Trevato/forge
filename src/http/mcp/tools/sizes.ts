import { sizesView } from "../../../spawn/sizes.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "sizes",
  doc: "what a child forge's sizes mean: small, medium and large, each with CPU, memory and disk",
  description:
    "A child forge's sizes: small, medium and large, each with CPU, memory and disk.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run: () => good(sizesView()),
};
