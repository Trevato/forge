/**
 * The browser half of passkeys: small ceremonies, inlined (nonce'd) on the
 * pages that need them. A page without script still works; it just
 * has no passkey button. Binary travels as base64url, as the server expects.
 */
export const passkeyJs = /* js */ `
(function () {
  var doc = document;
  // Controls marked data-passkey="on" show only where a passkey can actually run.
  function each(sel, fn) { if (doc.querySelectorAll) Array.prototype.forEach.call(doc.querySelectorAll(sel), fn); }
  if (window.PublicKeyCredential && navigator.credentials) doc.documentElement.classList.add('passkey');
  if (window.PublicKeyCredential && navigator.credentials) {
    each('[data-passkey="on"]', function (el) { el.hidden = false; });
    // A password fallback goes, unless the page came back with a word about the password (data-keep).
    each('[data-passkey="off"]', function (el) { if (!el.hasAttribute('data-keep')) el.hidden = true; });
  }
  function bytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function text(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.message || 'That did not work.');
        return j;
      });
    });
  }
  // A failure is an alert in the danger style, the class the note names in
  // data-fail; a cancel or a clear goes back to quiet.
  function say(note, msg, failed) {
    if (!note) return;
    var danger = note.getAttribute('data-fail');
    note.textContent = msg;
    if (danger) note.classList.toggle(danger, failed);
    note.classList.toggle('muted', !failed);
    if (failed) note.setAttribute('role', 'alert'); else note.setAttribute('role', 'status');
  }
  function wire(id, run) {
    var el = doc.getElementById(id);
    if (!el) return;
    var note = doc.getElementById(id + '-note');
    if (!window.PublicKeyCredential || !navigator.credentials) {
      el.disabled = true;
      if (note) note.textContent = 'This browser has no passkey support.';
      return;
    }
    el.addEventListener('click', function (e) {
      e.preventDefault();
      el.disabled = true;
      say(note, '', false);
      run().catch(function (err) {
        var cancelled = err && err.name === 'NotAllowedError';
        say(note, cancelled ? 'Cancelled.' : (err && err.message) || 'That did not work.', !cancelled);
        el.disabled = false;
      });
    });
  }
  wire('passkey-add', function () {
    var name = doc.getElementById('passkey-name');
    return post('/settings/passkeys/options').then(function (o) {
      return navigator.credentials.create({ publicKey: {
        challenge: bytes(o.challenge),
        rp: { id: o.rpId, name: o.rpName },
        user: { id: bytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        excludeCredentials: o.exclude.map(function (c) { return { type: 'public-key', id: bytes(c) }; }),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120000
      } }).then(function (cred) {
        return post('/settings/passkeys', {
          name: name ? name.value : '',
          challenge: o.challenge,
          clientDataJSON: text(cred.response.clientDataJSON),
          attestationObject: text(cred.response.attestationObject)
        });
      });
    }).then(function () { location.reload(); });
  });
  wire('passkey-recover', function () {
    var name = doc.getElementById('passkey-name');
    var token = new URLSearchParams(location.search).get('token') || '';
    return post('/recover/options', { token: token }).then(function (o) {
      return navigator.credentials.create({ publicKey: {
        challenge: bytes(o.challenge),
        rp: { id: o.rpId, name: o.rpName },
        user: { id: bytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        excludeCredentials: o.exclude.map(function (c) { return { type: 'public-key', id: bytes(c) }; }),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120000
      } }).then(function (cred) {
        return post('/recover/passkey', {
          token: token,
          name: name ? name.value : '',
          challenge: o.challenge,
          clientDataJSON: text(cred.response.clientDataJSON),
          attestationObject: text(cred.response.attestationObject)
        });
      });
    }).then(function (r) { location.href = r.next; });
  });
  wire('passkey-signup', function () {
    function val(n) { var el = doc.querySelector('[name=' + n + ']'); return el ? el.value : ''; }
    var who = { username: val('username'), email: val('email') };
    return post('/signup/passkey/options' + location.search, who).then(function (o) {
      return navigator.credentials.create({ publicKey: {
        challenge: bytes(o.challenge),
        rp: { id: o.rpId, name: o.rpName },
        user: { id: bytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120000
      } }).then(function (cred) {
        return post('/signup/passkey' + location.search, {
          username: who.username,
          email: who.email,
          note: val('note'),
          humanToken: val('cf-turnstile-response'),
          challenge: o.challenge,
          clientDataJSON: text(cred.response.clientDataJSON),
          attestationObject: text(cred.response.attestationObject)
        });
      });
    }).then(function (r) { location.href = r.next; });
  });
  // A form that makes an account (the claim link, the everyday account):
  // the key goes into its hidden fields and the form posts as it always did.
  wire('passkey-make', function () {
    var el = doc.getElementById('passkey-make'), form = el.form;
    function val(n) { var f = form.elements[n]; return f ? f.value : ''; }
    if (form.reportValidity && !form.reportValidity()) { el.disabled = false; return Promise.resolve(); }
    var who = { token: val('token'), username: val('username'), email: val('email') };
    return post(el.getAttribute('data-options'), who).then(function (o) {
      return navigator.credentials.create({ publicKey: {
        challenge: bytes(o.challenge),
        rp: { id: o.rpId, name: o.rpName },
        user: { id: bytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120000
      } }).catch(function (err) {
        // No passkey was made on this device: the form's password, where it has one, comes out.
        var why = doc.getElementById('password-why');
        if (why) why.textContent = 'No passkey on this device? Choose a password instead.';
        each('[data-passkey="off"]', function (off) { off.hidden = false; off.classList.add('mt'); });
        each('[data-passkey="off"] [data-variant="primary"]', function (b) { b.setAttribute('data-variant', 'outline'); });
        throw err;
      }).then(function (cred) {
        form.elements.challenge.value = o.challenge;
        form.elements.clientDataJSON.value = text(cred.response.clientDataJSON);
        form.elements.attestationObject.value = text(cred.response.attestationObject);
        form.submit();
      });
    });
  });
  wire('passkey-signin', function () {
    return post('/signin/passkey/options').then(function (o) {
      return navigator.credentials.get({ publicKey: {
        challenge: bytes(o.challenge),
        rpId: o.rpId,
        userVerification: 'required',
        timeout: 120000
      } }).then(function (cred) {
        return post('/signin/passkey' + location.search, {
          challenge: o.challenge,
          id: text(cred.rawId),
          clientDataJSON: text(cred.response.clientDataJSON),
          authenticatorData: text(cred.response.authenticatorData),
          signature: text(cred.response.signature)
        });
      });
    }).then(function (r) { location.href = r.next; });
  });
})();
`;
