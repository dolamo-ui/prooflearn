/* Share links and QR codes. Runs in the browser only.
   The link is  <app address>/?join=TABCD234  and Shell opens it straight away.
   The QR code is drawn in the browser (no outside service), so it also works offline. */

const raw = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The address people should use. Set NEXT_PUBLIC_APP_URL when the app is online or on a network address. */
export const appBase = (): string => (process.env.NEXT_PUBLIC_APP_URL || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/+$/, "");
export const shareUrl = (code: string): string => `${appBase()}/?join=${raw(code)}`;
export const isLocalAddress = (): boolean => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(appBase());

/** If the page was opened from a share link, returns the code (and cleans the address bar). */
export function codeFromLink(): string {
  try {
    const u = new URL(window.location.href);
    const c = raw((u.searchParams.get("join") || "").slice(0, 12));
    if (!c) return "";
    u.searchParams.delete("join");
    window.history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    return c.length === 8 ? c : "";
  } catch { return ""; }
}

/** A PNG picture of the QR code, as a data: address. */
export async function qrDataUrl(text: string, width = 480): Promise<string> {
  const QR = await import("qrcode");
  return QR.toDataURL(text, { width, margin: 2, errorCorrectionLevel: "M", color: { dark: "#14235a", light: "#ffffff" } });
}
