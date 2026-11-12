/**
 * The claim code a new forge hands its first person (#11202): what it looks
 * like, the address of the waiting page that carries it in the fragment, and
 * the script that tells the server a browser ran script.
 */
import { isChildName } from "../core/proposal_token.ts";

/** What the claim code looks like: 32 random bytes, base64url. */
export const CLAIM_CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Sets `js=1` on the forms that ask for it (`data-js`), so the answer can tell
 * a browser that ran this script (sent to the waiting page, the code in the
 * fragment) from one that did not (shown the link once).
 */
export const JS_FLAG_JS = /* js */ `
(function () {
  var forms = document.querySelectorAll("form[data-js]");
  for (var i = 0; i < forms.length; i++) {
    var f = document.createElement("input");
    f.type = "hidden"; f.name = "js"; f.value = "1";
    forms[i].appendChild(f);
  }
})();
`;

/** The waiting page for a new forge, the claim code in the fragment only (never sent to a server). */
export function waitingAddress(body: Record<string, unknown>): string | undefined {
  const link = body["claimUrl"];
  const name = String(body["name"] ?? "");
  if (typeof link !== "string" || !isChildName(name)) return undefined;
  const code = link.split("#")[1] ?? "";
  return CLAIM_CODE.test(code) ? `/forges/${name}/waiting#${code}` : undefined;
}
