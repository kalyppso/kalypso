import type { ReactNode } from "react";
import { CircleAlert, ShieldAlert } from "lucide-react";
import { useStore } from "../store";
import { openSettings } from "../views/Settings";
import { explainFailure, type Failure } from "../failures";

export { explainFailure, type Failure };

/** A failure, shown where it happened: what went wrong, why, and buttons to fix it. */
export function FailureCard({ failure, actions, tone = "error" }: { failure: Failure; actions?: ReactNode; tone?: "error" | "blocked" }) {
  const { dispatch } = useStore();
  const go = failure.go;
  return (
    <div className={`failure ${tone}`} role="alert">
      <span className="failure-icon">{tone === "blocked" ? <ShieldAlert size={15} /> : <CircleAlert size={15} />}</span>
      <div className="failure-body">
        <div className="failure-title">{failure.title}</div>
        <div className="failure-detail">{failure.detail}</div>
        {failure.hint && <div className="failure-hint">{failure.hint}</div>}
        {(actions || go) && (
          <div className="failure-actions">
            {actions}
            {go && (
              <button className="btn sm" onClick={() => (go.settings ? openSettings(dispatch, go.settings) : go.view && dispatch({ type: "view", view: go.view }))}>
                {go.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
