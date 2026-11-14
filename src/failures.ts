import { describeError } from "./errors";
import type { ViewId } from "./types";

/** Why something failed, in words, with what to do and where to do it. */
export interface Failure { title: string; detail: string; hint?: string; go?: { label: string; view?: ViewId; settings?: "models" } }

/**
 * Read a failure reported by an agent, a run or a task ("Stopped by an error", "crashed 3 times
 * (exit 137)", "groq answered 429: …") and say what it means and what to do.
 */
export function explainFailure(text: string): Failure {
  const t = text.trim();
  const has = (re: RegExp) => re.test(t);
  const detail = t;
  if (has(/rate.?limit|answered 429|too many requests|kept rate limiting/i)) {
    return { title: "The model provider is rate limiting", detail, hint: "It passes on its own. Try again in a minute, slow the work down, or pick a model or plan with higher limits.", go: { label: "Open Models", settings: "models" } };
  }
  if (has(/budget|cap reached|answered 402/i)) return { title: "Stopped at the budget", detail, hint: "Raise the cap or wait for the next period.", go: { label: "Open Spend", view: "budget" } };
  if (has(/refused|answered 401|answered 403|no working key|api.?key|unauthori[sz]ed/i)) {
    return { title: "The model provider refused the key", detail, hint: "Check or replace the provider's key.", go: { label: "Open Models", settings: "models" } };
  }
  if (has(/no (kalypso )?agent runner|has no agent runner/i)) {
    return { title: "This sandbox can't run agents", detail, hint: "Its image has no agent runner. Use a sandbox made from the agent runner image.", go: { label: "Open Sandboxes", view: "sandboxes" } };
  }
  if (has(/no kalypso gateway key|reach the kalypso gateway/i)) return { title: "The sandbox can't reach KALYPSO", detail, hint: "Restart the sandbox so KALYPSO can set it up again.", go: { label: "Open Sandboxes", view: "sandboxes" } };
  if (has(/exit 137|killed|out of memory|oom/i)) return { title: "It was killed", detail, hint: "Usually it ran out of memory. Give its sandbox more memory, or split the work.", go: { label: "Open Sandboxes", view: "sandboxes" } };
  if (has(/gave up after|crashed/i)) return { title: "It kept crashing", detail, hint: "Open its conversation for the last error before it stopped, then start it again." };
  if (has(/limit of \d+ turns|max.?turns/i)) return { title: "It reached its turn limit", detail, hint: "Raise its turns per task in Edit, or break the work into smaller tasks." };
  if (has(/kalypso (closed|restarted)/i)) return { title: "Interrupted when KALYPSO closed", detail, hint: "Nothing is lost. Start it again to carry on." };
  if (has(/couldn't start|could not start|isn't running|no container runtime|container engine|podman|docker/i)) {
    return { title: "It couldn't start", detail, hint: "Check that Podman or Docker is running and the agent has a sandbox.", go: { label: "Open Sandboxes", view: "sandboxes" } };
  }
  if (has(/couldn't reach|could not reach|timed? ?out|network|econn/i)) return { title: "Couldn't reach the model", detail, hint: "Check your connection and the provider's address, then try again.", go: { label: "Open Models", settings: "models" } };
  if (has(/^blocked/i)) return { title: "Blocked by a rule", detail, hint: "That's working as intended. Change the rule if the agent should be allowed this.", go: { label: "Open Rules", view: "policies" } };
  const d = describeError({ message: t });
  return { title: d.title === "Something went wrong" ? "It stopped with an error" : d.title, detail, hint: d.hint };
}
