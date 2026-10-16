/**
 * The browser half of passkeys: two small ceremonies, inlined (nonce'd) on
 * the two pages that need them. A page without script still works; it just
 * has no passkey button. Binary travels as base64url, as the server expects.
 */
export const passkeyJs = /* js */ `
(function () {
  var doc = document;
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
      if (note) note.textContent = '';
      run().catch(function (err) {
        if (note) note.textContent = err && err.name === 'NotAllowedError' ? 'Cancelled.' : (err && err.message) || 'That did not work.';
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
  wire('passkey-signup', function () {
    function val(n) { var el = doc.querySelector('[name=' + n + ']'); return el ? el.value : ''; }
    var who = { username: val('username'), email: val('email') };
    return post('/signup/passkey/options', who).then(function (o) {
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
          humanToken: val('cf-turnstile-response'),
          challenge: o.challenge,
          clientDataJSON: text(cred.response.clientDataJSON),
          attestationObject: text(cred.response.attestationObject)
        });
      });
    }).then(function (r) { location.href = r.next; });
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
