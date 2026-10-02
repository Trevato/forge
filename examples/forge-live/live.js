// The forge said something changed: fetch the list again. Several events
// in a burst are one refetch.
const list = document.getElementById("now");
let pending;
const refresh = () => {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    const answer = await fetch("now", { headers: { accept: "text/html" } });
    if (answer.ok) list.innerHTML = await answer.text();
  }, 250);
};
if (list) new EventSource("live").addEventListener("changed", refresh);
