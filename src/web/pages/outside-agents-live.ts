/**
 * Settings: the outside agents' block (#12012) follows tokens made or revoked from any
 * door without a reload. Its own stream, only on a settings page that has the block, so
 * the repository page's script carries none of it.
 */
export const outsideAgentsJs = /* js */ `
(function () {
  if (!document.getElementById('contribute-tokens')) return;
  var es = new EventSource(location.pathname.split('/').slice(0, 3).join('/') + '/stream');
  function refresh() {
    fetch(location.pathname).then(function (r) { return r.text(); }).then(function (t) {
      var h = document.createElement('div');
      h.innerHTML = t;
      var mine = document.getElementById('contribute-tokens'), next = h.querySelector('#contribute-tokens');
      if (mine && next && mine.innerHTML !== next.innerHTML) mine.replaceWith(next);
    }).catch(function () {});
  }
  ['contribute.open', 'contribute.token', 'contribute.revoked'].forEach(function (k) {
    es.addEventListener(k, refresh);
  });
})();
`;
