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
 */
export const beaconJs = `!function(n,d,w){
if(n.doNotTrack=="1"||/(^|; )forge_measure=off/.test(d.cookie)||!n.sendBeacon||!w.PerformanceObserver)return;
var c=0,i=0,l=0,x=0,a=location.pathname;
function o(t,f,e){try{new PerformanceObserver(function(s){s.getEntries().forEach(f)}).observe(Object.assign({type:t,buffered:true},e))}catch(_){}}
o("largest-contentful-paint",function(e){l=e.startTime});
o("layout-shift",function(e){e.hadRecentInput||(c+=e.value)});
o("event",function(e){e.interactionId&&e.duration>i&&(i=e.duration)},{durationThreshold:40});
function s(){if(x)return;x=1;var v=performance.getEntriesByType("navigation")[0]||{};
n.sendBeacon("/_measure",JSON.stringify({path:a,ttfb:v.responseStart||0,load:v.loadEventEnd||0,lcp:l,inp:i,cls:c}))}
d.addEventListener("visibilitychange",function(){d.visibilityState=="hidden"&&s()});
w.addEventListener("pagehide",s)
}(navigator,document,window)`;
