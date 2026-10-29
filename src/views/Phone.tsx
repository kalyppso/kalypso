import { useState } from "react";
import { RotateCw } from "lucide-react";
import { PageHead } from "../components/ui";

const DEVICES = [
  { id: "iphone15", label: "iPhone 15", w: 393, h: 852 },
  { id: "pixel8", label: "Pixel 8", w: 412, h: 915 },
  { id: "galaxy-s24", label: "Galaxy S24", w: 360, h: 780 },
  { id: "iphone-se", label: "iPhone SE", w: 375, h: 667 },
];

// Inner screen size of the phone frame in styles.css (.phone minus padding).
const SCREEN_W = 276;

export function Phone() {
  const [deviceId, setDeviceId] = useState(DEVICES[0].id);
  const [url, setUrl] = useState("https://example.com");
  const [draft, setDraft] = useState(url);
  const [nonce, setNonce] = useState(0);
  const device = DEVICES.find((d) => d.id === deviceId)!;
  const scale = SCREEN_W / device.w;

  return (
    <>
      <PageHead title="Phone" subtitle="Preview what your agents build at real device sizes." />
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

        <div className="card" style={{ flex: 1, minWidth: 280, display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="field">Device
            <select className="select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.label} ({d.w}×{d.h})</option>)}
            </select>
          </label>
          <form className="field" onSubmit={(e) => { e.preventDefault(); setUrl(/^https?:\/\//.test(draft) ? draft : `https://${draft}`); }}>
            URL
            <div className="row">
              <input className="input mono" style={{ flex: 1 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button className="btn primary" style={{ padding: "8px 16px" }}>Open</button>
              <button type="button" className="btn" onClick={() => setNonce(nonce + 1)}><RotateCw size={14} /></button>
            </div>
          </form>
          <div className="dim" style={{ fontSize: 12.5 }}>
            Tip: point this at a sandbox's forwarded port (e.g. <span className="mono">http://localhost:5173</span>) to watch an agent's app update live.
          </div>
        </div>
      </div>
    </>
  );
}
