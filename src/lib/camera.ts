/**
 * Camera: letting Nomin see live video, not just uploaded files.
 *
 * Uses getUserMedia so the raw stream never leaves the machine — frames are
 * captured to JPEG data URLs locally and only those stills travel with the
 * request, exactly like an uploaded video's sampled frames.
 */

export interface CameraSupport {
  ok: boolean;
  reason?: string;
}

export function cameraSupport(): CameraSupport {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: "This browser cannot open a camera." };
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return { ok: false, reason: "Camera needs a secure connection (https or localhost)." };
  }
  return { ok: true };
}

/** Open the camera. Caller must stop every track when done. */
export async function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
}

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Grab one still from a live <video> element, downscaled for a vision call. */
export function captureStill(video: HTMLVideoElement, maxEdge = 1024): string | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

/** A captured still as a File, so it flows through the normal attach path. */
export function stillToFile(dataUrl: string, index: number): File | null {
  try {
    const [header, body] = dataUrl.split(",");
    const mime = /data:(.*?);/.exec(header ?? "")?.[1] ?? "image/jpeg";
    const binary = atob(body ?? "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `camera-${Date.now()}-${index}.jpg`, { type: mime });
  } catch {
    return null;
  }
}
