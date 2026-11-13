/**
 * The answer to "make me a forge", for whoever asked: one page that says what
 * is happening while the forge starts (made, starting, answering, ready, read
 * from `GET /forges/<name>/ready`) and hands over its one link the moment it
 * answers. The person who made it for themselves gets **Open <name>**; the
 * person who made it for someone else gets the link to send. Both get a code
 * a phone's camera opens, beside the link and a way to copy it, and are told
 * plainly that whoever holds the link owns the forge.
 *
 * The link is in this one `no-store` body. Without script the page says how
 * long a start usually takes and shows the link at once.
 */
import { qrEncode, qrSvg } from "../design/qr.ts";
import { pageHead } from "./chrome.ts";
import { html, raw, type Html } from "./html.ts";
import { btn, row } from "./ui.ts";

/** How long a new forge usually takes to answer, in seconds: what the page tells the person waiting. */
export const USUAL_START_SECONDS = 15;

/** The sentence for each step, the same in the page's first paint and in its script. */
export const madeWords = (name: string) =>
  ({
    starting: `${name} is made and is starting. This usually takes about ${USUAL_START_SECONDS} seconds.`,
    answering: `${name} is running. Checking that its address answers.`,
    ready: `${name} is ready.`,
    slow: `${name} is taking longer than usual. This page keeps checking.`,
  }) as const;

/**
 * Asks whether the forge answers, four times a second at most, and says each
 * step as it comes. Ready shows the link; on a phone, where the person who
 * made it has no other device to move to, ready opens the forge.
 */
export const madeJs = /* js */ `
(function () {
  var doc = document, root = doc.getElementById("made");
  if (!root || !window.fetch) return;
  var says = doc.getElementById("made-says"), link = doc.getElementById("made-link"), open = doc.getElementById("made-open");
  var words = JSON.parse(root.getAttribute("data-words")), name = root.getAttribute("data-name"), began = Date.now();
  if (open) link.hidden = true;
  function say(step) { if (says.textContent !== words[step]) says.textContent = words[step]; }
  function ready() {
    say("ready");
    if (open && window.matchMedia && matchMedia("(max-width: 719px)").matches) { location.replace(open.href); return; }
    link.hidden = false;
    if (open) open.focus();
  }
  function again() { setTimeout(ask, Date.now() - began > 60000 ? 2000 : 250); }
  function ask() {
    fetch("/forges/" + encodeURIComponent(name) + "/ready", { credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ready === true) return ready();
        say(Date.now() - began > 60000 ? "slow" : j && j.step === "answering" ? "answering" : "starting");
        again();
      })
      .catch(again);
  }
  ask();
})();
`;

/** The code a phone's camera opens, at most 200 px square; nothing when the link is too long for one. */
function phoneCode(link: string, says: string): Html | null {
  const code = qrEncode(link);
  if (!code.ok) return null;
  const scale = Math.max(
    1,
    Math.min(4, Math.floor(200 / code.value.modules.length)),
  );
  return html`<div class="to-phone stack stack-tight">
    <p class="muted small">${says}</p>
    ${raw(
      qrSvg(code.value, {
        title: "A code that opens the link on a phone",
        scale,
      }),
    )}
  </div>`;
}

/** The link as text with its copy button: the primary action when it is a link to send. */
function linkRow(link: string, primary: boolean): Html {
  return html`<ul class="list setting-list">
    ${row({
      title: html`<code class="mono" id="claim-link">${link}</code>`,
      trail: btn("Copy the link", {
        type: "button",
        copy: "claim-link",
        icon: "copy",
        size: "sm",
        ...(primary ? { variant: "primary" as const } : {}),
      }),
    })}
  </ul>`;
}

/** The link someone else is sent: what to do with it, the link, the code. `after` is the page's own (a list to go back to). */
export function linkToSend(link: string, after?: Html | null): Html {
  return html`<p>
      Send this link to the person it is for, and to them alone: whoever opens
      it first owns the forge. It works once, for a day, and is shown only now.
    </p>
    ${linkRow(link, true)}
    ${phoneCode(link, "Beside them? Their phone's camera opens it.")}
    ${after ?? null}`;
}

export interface Made {
  readonly name: string;
  readonly link: string;
  /** True when the person made it for themselves: the page opens it; false when it is a link to send. */
  readonly own: boolean;
  /** What follows the link on a sender's page. */
  readonly after?: Html | null;
}

/** The page's body: the step said aloud, then the link. */
export function madeBody(o: Made): Html {
  const words = madeWords(o.name);
  return html`<div
    class="narrow stack"
    id="made"
    data-name="${o.name}"
    data-words="${JSON.stringify(words)}"
  >
    ${pageHead(o.own ? "Your new forge" : "A forge to send")}
    <p id="made-says" role="status">${words.starting}</p>
    <div id="made-link" class="stack">
      ${o.own
        ? html`<p>
              ${btn(`Open ${o.name}`, {
                href: o.link,
                variant: "primary",
                size: "lg",
                id: "made-open",
              })}
            </p>
            ${phoneCode(
              o.link,
              "To carry on from your phone, point its camera here.",
            )}
            ${linkRow(o.link, false)}
            <p class="muted small">
              Whoever holds this link owns the forge. It works once, for a day.
            </p>`
        : linkToSend(o.link, o.after)}
    </div>
  </div>`;
}
