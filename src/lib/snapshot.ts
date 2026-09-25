/**
 * Rasterise a generated page so the monitor can look at it.
 *
 * The rendering is done with an SVG `foreignObject`, not by screenshotting the
 * live preview, for one important reason: a `foreignObject` lays out and
 * styles the markup but **never executes scripts**, so model-written code
 * cannot reach this origin. The alternative — giving the preview iframe
 * `allow-same-origin` so its DOM could be captured — would hand generated
 * JavaScript access to the app's own storage and API.
 *
 * The trade-off is honest and worth stating: layout, typography and colour are
 * captured; script-driven content and cross-origin images are not. Anything
 * that fails to rasterise returns null, and the monitor falls back to
 * reviewing the code alone rather than guessing.
 */

const WIDTH = 1200;
const HEIGHT = 900;
const TIMEOUT_MS = 6000;

export async function captureDocument(html: string): Promise<string | null> {
  if (typeof document === "undefined" || !html.trim()) return null;

  try {
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`,
      `<foreignObject width="100%" height="100%">`,
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#fff">`,
      inlineBody(html),
      `</div></foreignObject></svg>`,
    ].join("");

    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = await loadImage(url);

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(image, 0, 0, WIDTH, HEIGHT);

    // JPEG keeps the payload small enough to send on every review.
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/**
 * Pull the body and styles out of a full document and strip anything that
 * cannot render inside a foreignObject (scripts, external resources).
 */
function inlineBody(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, noscript, iframe, object, embed").forEach((node) => node.remove());

  // Cross-origin images taint the canvas, which would make export fail.
  parsed.querySelectorAll("img").forEach((node) => {
    const src = node.getAttribute("src") ?? "";
    if (!src.startsWith("data:")) {
      node.setAttribute("src", "");
      node.setAttribute("alt", node.getAttribute("alt") ?? "image");
      node.setAttribute("style", `${node.getAttribute("style") ?? ""};background:#e9e7f2;min-height:80px`);
    }
  });

  const styles = Array.from(parsed.querySelectorAll("style"))
    .map((node) => node.textContent ?? "")
    .join("\n");

  // Serialise as XHTML — foreignObject is XML, so unclosed tags would break it.
  // Extract body children only to avoid nesting <body> inside the wrapper <div>.
  const children = Array.from(parsed.body.childNodes)
    .map((node) => new XMLSerializer().serializeToString(node))
    .join("");
  return `<style>${styles}</style>${children}`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error("render timed out")), TIMEOUT_MS);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("render failed"));
    };
    image.src = url;
  });
}
