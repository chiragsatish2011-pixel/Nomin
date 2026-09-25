/**
 * A runtime check for generated pages.
 *
 * The monitor's rasterisation deliberately runs no scripts, which means a page
 * can look finished and still be dead: a typo in an event handler, a null
 * element, a thrown exception before any listener is attached. Looking at a
 * picture will never catch that.
 *
 * So the page is also *run* — in a frame sandboxed with `allow-scripts` and
 * nothing else, so it has an opaque origin and cannot touch this app's storage
 * or API. A small reporter shim is injected ahead of the page's own code; it
 * cannot read anything back out, it only posts errors to the parent. That is
 * enough to tell a working page from a broken one, which is the whole point.
 */

export interface RuntimeCheck {
  ran: boolean;
  errors: string[];
  /** Elements the page ended up with — a dead page usually has very few. */
  nodes: number;
}

const SETTLE_MS = 1400;

const REPORTER = `<script>(function(){
  var send=function(m){try{parent.postMessage({__nomin:1,error:String(m).slice(0,300)},'*')}catch(e){}};
  window.onerror=function(m,s,l,c){send(m+' ('+l+':'+c+')');return false};
  window.addEventListener('unhandledrejection',function(e){send('unhandled rejection: '+(e.reason&&e.reason.message||e.reason))});
  window.addEventListener('load',function(){
    try{parent.postMessage({__nomin:1,nodes:document.getElementsByTagName('*').length},'*')}catch(e){}
  });
})();</script>`;

export async function probeRuntime(html: string): Promise<RuntimeCheck> {
  if (typeof document === "undefined" || !html.trim()) {
    return { ran: false, errors: [], nodes: 0 };
  }

  const result: RuntimeCheck = { ran: false, errors: [], nodes: 0 };
  const frame = document.createElement("iframe");
  // No allow-same-origin: the page runs with an opaque origin and cannot reach
  // this app. It can still postMessage, which is all the shim needs.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1024px;height:800px;border:0";
  frame.srcdoc = inject(html);

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { __nomin?: number; error?: string; nodes?: number } | null;
    if (!data || data.__nomin !== 1 || event.source !== frame.contentWindow) return;
    result.ran = true;
    if (data.error) result.errors.push(data.error);
    if (typeof data.nodes === "number") result.nodes = data.nodes;
  };

  window.addEventListener("message", onMessage);
  document.body.append(frame);

  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

  window.removeEventListener("message", onMessage);
  frame.remove();

  // De-duplicate: one broken handler can fire the same error repeatedly.
  result.errors = [...new Set(result.errors)].slice(0, 6);
  return result;
}

/** Put the reporter ahead of the page's own scripts. */
function inject(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (tag) => `${tag}\n${REPORTER}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (tag) => `${tag}\n${REPORTER}`);
  return `${REPORTER}\n${html}`;
}
