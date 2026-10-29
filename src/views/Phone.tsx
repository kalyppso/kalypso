import { useState } from "react";
import { RotateCw } from "lucide-react";

const DEVICES = [
  { id: "iphone15", label: "iPhone 15", w: 393, h: 852 },
  { id: "pixel8", label: "Pixel 8", w: 412, h: 915 },
  { id: "galaxy-s24", label: "Galaxy S24", w: 360, h: 780 },
  { id: "iphone-se", label: "iPhone SE", w: 375, h: 667 },
];

// Inner screen size of the phone frame in styles.css (.phone minus padding).
const SCREEN_W = 276;

// Device preview pane in the tools layer.
export function PhonePane() {
  const [deviceId, setDeviceId] = useState(DEVICES[0].id);
  const [url, setUrl] = useState("https://example.com");
  const [draft, setDraft] = useState(url);
  const [nonce, setNonce] = useState(0);
  const device = DEVICES.find((d) => d.id === deviceId)!;
  const scale = SCREEN_W / device.w;

  return (
    <div className="phone-pane">
      <form className="urlbar" onSubmit={(e) => { e.preventDefault(); setUrl(/^https?:\/\//.test(draft) ? draft : `https://${draft}`); }}>
        <select className="select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Device">
          {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.label} ({d.w}×{d.h})</option>)}
        </select>
        <input className="input mono" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="URL" title="Tip: point this at a sandbox's forwarded port, e.g. http://localhost:5173" />
        <button className="btn sm">Open</button>
        <button type="button" className="btn ghost sm" onClick={() => setNonce(nonce + 1)} aria-label="Reload"><RotateCw size={14} /></button>
      </form>
      <div className="phone-stage">
        <div className="phone">
          <div className="notch" />
          <div className="phone-screen">
            <iframe
              key={nonce}
              src={url}
              title="Phone preview"
              sandbox="allow-scripts allow-same-origin allow-forms"
              style={{ width: device.w, height: device.h, transform: `scale(${scale})`, transformOrigin: "0 0" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
