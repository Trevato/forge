/**
 * The draft: what a person has typed into the feed composer, kept in the
 * browser so a reload or a closed tab does not lose it (#5913). Saved a
 * second after the last keystroke, put back only into an empty box, dropped
 * once the tell is sent, and forgotten at sign-out.
 *
 * Shipped to the page as source text (like the outbox) and evaluated by the
 * test with a fake storage and timer, so the code that runs is the code
 * that is tested.
 */

export const DRAFT_PREFIX = "draft.";
export const DRAFT_DELAY_MS = 1000;

export const draftJs = /* js */ `
function forgeDraft(storage, box, key, later) {
  var PREFIX = ${JSON.stringify(DRAFT_PREFIX)};
  var DELAY = ${DRAFT_DELAY_MS};
  var pending = false;
  var round = 0;
  function save() {
    pending = false;
    try {
      if (box.value) storage.setItem(key, box.value);
      else storage.removeItem(key);
    } catch (e) {}
  }
  return {
    // Put the saved words back, unless the person has already typed.
    restore: function () {
      if (box.value) return;
      try { box.value = storage.getItem(key) || ''; } catch (e) {}
    },
    // One timer per burst of typing, not one per keystroke.
    typed: function () {
      if (pending) return;
      pending = true;
      var mine = round;
      later(function () { if (mine === round) save(); }, DELAY);
    },
    // A refused send: give the words back unless new ones have been typed.
    refused: function (text) {
      if (!box.value) box.value = text;
      save();
    },
    // The words are sent: drop the saved copy and any save still waiting.
    clear: function () {
      round++;
      pending = false;
      try { storage.removeItem(key); } catch (e) {}
    },
    // Sign-out: every saved draft of this browser, whoever's it was.
    forgetAll: function () {
      try {
        var keys = [];
        for (var i = 0; i < storage.length; i++) keys.push(storage.key(i));
        keys.forEach(function (name) {
          if (name.startsWith(PREFIX)) storage.removeItem(name);
        });
      } catch (e) {}
    }
  };
}
`;
