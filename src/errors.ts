// Errors, made readable for people: used by toasts, inline messages and failure cards.

/** An error, ready to show: a short title, what happened in a full sentence, and what to do. */
export interface ErrorInfo { title: string; detail: string; hint?: string; code?: string }

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const up = t[0].toUpperCase() + t.slice(1);
  return /[.!?…)]$/.test(up) ? up : `${up}.`;
};

/** Make any error from the core, the network or the code readable. Never loses the original text. */
export function describeError(e: unknown): ErrorInfo {
  const raw = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "Unknown error");
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
  // The core prefixes some messages with their kind ("container runtime: …", "vault: …"); the title says it instead.
  const body = raw.replace(/^(container runtime|vault|database|io):\s*/i, "");
  const detail = sentence(body);
  const has = (re: RegExp) => re.test(raw);
  // The browser preview has no core behind it.
  if (has(/reading 'invoke'|__TAURI|tauri.*not.*(found|available)/i)) {
    return { code, title: "Only in the desktop app", detail: "This needs the KALYPSO core, which runs in the desktop app.", hint: "Sample data here is for looking around." };
  }
  if (code === "runtime" || has(/container runtime|podman|docker|engine/i)) {
    return { code, title: "Container engine problem", detail, hint: has(/no container runtime|not running|connect|socket|refused/i) ? "Start Podman or Docker, then try again. KALYPSO connects as soon as one answers." : undefined };
  }
  if (has(/rate.?limit|429|too many requests/i)) return { code, title: "Rate limited by the model provider", detail, hint: "It's temporary. Wait a moment and try again, or use a model with higher limits." };
  if (has(/budget|cap reached|402/i)) return { code, title: "Budget reached", detail, hint: "Raise the cap or wait for the next period, in Spend." };
  if (has(/api.?key|401|403|unauthori[sz]ed|refused (the|kalypso's) request|no working key/i)) return { code, title: "The model provider refused the key", detail, hint: "Check the provider's key in Settings → Models." };
  if (has(/failed to fetch|network|timed? ?out|couldn't reach|could not reach|econn|dns/i)) return { code, title: "Couldn't connect", detail, hint: "Check your connection, or that the service is running, then try again." };
  switch (code) {
    case "not_found": return { code, title: "Not found", detail, hint: "It may have been deleted. Refresh, or go back and try again." };
    case "conflict": return { code, title: "Already exists", detail, hint: "Pick another name, or change the existing one instead." };
    case "invalid": return { code, title: "That can't be done", detail };
    case "wrong_namespace": return { code, title: "Belongs to another namespace", detail, hint: "Switch to that namespace to change it." };
    case "vault": return { code, title: "Vault problem", detail, hint: "Your secrets are safe. If this keeps happening, restart KALYPSO." };
    case "database": case "io": return { code, title: "Something went wrong on this machine", detail, hint: "Try again. If it keeps happening, restart KALYPSO and copy the details into an issue." };
  }
  return { code, title: "Something went wrong", detail };
}

/** One readable sentence for an error, for toasts and inline messages. */
export function errorMessage(e: unknown): string {
  const d = describeError(e);
  // A refusal with its reason reads best alone ("Give the task a title."); everything else gets its title.
  if (d.title === "That can't be done" && !d.hint) return d.detail;
  return d.hint ? `${d.title}: ${d.detail} ${d.hint}` : `${d.title}: ${d.detail}`;
}
