import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Hand } from "lucide-react";
import { api, errorMessage, isLive, onPolicyApproval } from "../backend";
import type { ApprovalRequest } from "../bindings/ApprovalRequest";
import { useStore, useToast } from "../store";

/** Tool calls held by an "Ask me" policy, answered from anywhere in the app. */
export function ApprovalPrompt() {
  const { state } = useStore();
  const toast = useToast();
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!isLive() || !state.session) return;
    api.policyPending(state.ns).then(setQueue).catch(() => {});
    const off = onPolicyApproval((r) => {
      if (r.ns === state.ns) setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r]));
    });
    return () => void off.then((f) => f());
  }, [state.ns, state.session]);

  const req = queue[0];
  if (!req) return null;

  const answer = (approve: boolean) => {
    api.policyDecide(req.ns, req.id, approve, approve && remember)
      .then(() => toast(approve ? `Approved for ${req.source}` : `Denied ${req.source}`, approve ? "ok" : "warn"))
      // Already answered elsewhere or timed out: drop it either way.
      .catch((e) => toast(errorMessage(e), "err"))
      .finally(() => { setQueue((q) => q.filter((x) => x.id !== req.id)); setRemember(false); });
  };

  return createPortal(
    <div className="approval" role="alertdialog" aria-labelledby="approval-title">
      <div className="row" style={{ gap: 8 }}>
        <span className="action-icon" style={{ width: 28, height: 28 }}><Hand size={14} /></span>
        <div style={{ minWidth: 0 }}>
          <div id="approval-title" style={{ fontWeight: 600 }}>Approve this?</div>
          <div className="faint small">{req.source} · {req.policy}</div>
        </div>
        <span className="spacer" />
        {queue.length > 1 && <span className="badge">{queue.length - 1} more</span>}
      </div>
      <code className="approval-action">{req.action}</code>
      <div className="dim small">{req.reason}. {req.rule}</div>
      <label className="row small dim" style={{ gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
        Don't ask again for this run
      </label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={() => answer(false)}>Deny</button>
        <button className="btn primary" onClick={() => answer(true)} autoFocus>Approve</button>
      </div>
    </div>,
    document.body,
  );
}
