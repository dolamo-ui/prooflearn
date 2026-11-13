"use client";
import { useEffect, useState } from "react";
import { isLocalAddress, qrDataUrl, shareUrl } from "../lib/share";
import { CopyButton } from "./ui";

/** Code + link + QR code for something a teacher shared. Learners can type the code, tap the link or scan the picture. */
export default function ShareBox({ code, title, what = "test" }: { code: string; title: string; what?: string }) {
  const url = shareUrl(code);
  const [qr, setQr] = useState("");
  const [canShare, setCanShare] = useState(false);
  useEffect(() => { let off = false; qrDataUrl(url).then((d) => !off && setQr(d)).catch(() => !off && setQr("")); return () => { off = true; }; }, [url]);
  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);
  const message = `${title}: open it here ${url} (or type the code ${code} in ProofLearn)`;
  const sendOn = async () => { try { await navigator.share({ title, text: message, url }); } catch { /* cancelled */ } };

  return (
    <div className="sharebox">
      <div className="sharebox-qr">
        {qr ? <img src={qr} alt={`QR code that opens ${title}`} width={180} height={180} /> : <span className="spin" aria-hidden="true" />}
        {qr && <a className="ghost" href={qr} download={`${title.replace(/[^\w]+/g, "-").slice(0, 40) || "share"}-qr.png`}>Download QR</a>}
      </div>
      <div className="sharebox-info">
        <p><small>Code</small></p>
        <p className="bigcode" aria-label={`Share code ${code}`}>{code}</p>
        <p><small>Link</small></p>
        <p className="sharelink">{url}</p>
        <div className="actions">
          <CopyButton text={url} label="Copy link" />
          <CopyButton text={code} label="Copy code" />
          <a className="ghost" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
          {canShare && <button className="ghost" onClick={sendOn}>Share…</button>}
        </div>
        <p><small>Learners can scan the QR code, tap the link, or type the code on the home page. No account needed. Put the QR on the board or in your class chat.</small></p>
        {isLocalAddress() && <p className="warn">This link only opens on <b>this computer</b>. For phones to scan it, put ProofLearn online (or open it by your network address) and set <code>NEXT_PUBLIC_APP_URL</code> in <code>.env.local</code>. See README.</p>}
        <p className="no-show">{what}</p>
      </div>
    </div>
  );
}
