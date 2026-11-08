/**
 * The page-view beacon, as static source: one classic script, under 2 KB,
 * served content-addressed (`web/asset.ts`) and linked from every page. It
 * watches LCP, layout shift (CLS) and interaction latency (INP, the worst
 * interaction), and sends them once, with the route's path and the
 * navigation's TTFB and load time, when the page is hidden or left. The path
 * is read once, at start: the code browser moves with pushState, and the load
 * being measured belongs to the page that was loaded. Nothing
 * is sent under Do-Not-Track or with the `forge_measure=off` cookie; the
 * server checks both again. A metric it could not measure is 0 (or absent).
 * It also sends the referrer, the query string and the host of the last external
 * link clicked; the server keeps only the referrer's host, the three `utm_`
 * fields, and a clicked host that is in the named set (`perf/sources.ts`).
 */
export const beaconJs = `!function(n,d,w){
if(n.doNotTrack=="1"||/(^|; )forge_measure=off/.test(d.cookie)||!n.sendBeacon||!w.PerformanceObserver)return;
var c=0,i=0,l=0,x=0,u="",a=location.pathname;
function o(t,f,e){try{new PerformanceObserver(function(s){s.getEntries().forEach(f)}).observe(Object.assign({type:t,buffered:true},e))}catch(_){}}
o("largest-contentful-paint",function(e){l=e.startTime});
o("layout-shift",function(e){e.hadRecentInput||(c+=e.value)});
o("event",function(e){e.interactionId&&e.duration>i&&(i=e.duration)},{durationThreshold:40});
d.addEventListener("click",function(e){var t=e.target,k=t&&t.closest&&t.closest("a[href]");k&&k.hostname&&k.hostname!=location.hostname&&(u=k.hostname)},true);
function s(){if(x)return;x=1;var v=performance.getEntriesByType("navigation")[0]||{};
n.sendBeacon("/_measure",JSON.stringify({path:a,ttfb:v.responseStart||0,load:v.loadEventEnd||0,lcp:l,inp:i,cls:c,ref:d.referrer.slice(0,300),q:location.search.slice(0,300),out:u}))}
d.addEventListener("visibilitychange",function(){d.visibilityState=="hidden"&&s()});
w.addEventListener("pagehide",s)
}(navigator,document,window)`;
