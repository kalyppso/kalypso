import { describe, expect, it } from "vitest";
import { describeError, errorMessage } from "./errors";
import { explainFailure } from "./failures";

describe("describeError", () => {
  it("turns core errors into a title, a sentence and a hint", () => {
    const d = describeError({ code: "runtime", message: "container runtime: no container runtime is connected" });
    expect(d.title).toBe("Container engine problem");
    expect(d.detail).toBe("No container runtime is connected.");
    expect(d.hint).toMatch(/Start Podman or Docker/);
  });

  it("keeps the original words, capitalised, with a full stop", () => {
    expect(describeError({ code: "invalid", message: "give the task a title" }).detail).toBe("Give the task a title.");
    expect(errorMessage({ code: "invalid", message: "give the task a title" })).toBe("Give the task a title.");
    expect(describeError({ code: "conflict", message: "agent scout in work already exists" }).title).toBe("Already exists");
  });

  it("recognises provider trouble from the message", () => {
    expect(describeError(new Error("groq answered 429: Rate limit reached")).title).toMatch(/Rate limited/);
    expect(describeError("Failed to fetch").title).toBe("Couldn't connect");
  });

  it("explains what isn't possible outside the desktop app, and titles the unexpected", () => {
    expect(describeError(new TypeError("Cannot read properties of undefined (reading 'invoke')")).title).toBe("Only in the desktop app");
    expect(errorMessage(new TypeError("x is not a function"))).toBe("Something went wrong: X is not a function.");
  });

  it("never shows an empty message", () => {
    expect(describeError(undefined).detail).toBe("Unknown error.");
    expect(errorMessage(null)).not.toBe("");
  });
});

describe("explainFailure", () => {
  it("explains the failures agents and tasks report, with where to fix them", () => {
    const rate = explainFailure("groq kept rate limiting after 8 tries: Limit 7000, Used 4062");
    expect(rate.title).toMatch(/rate limiting/);
    expect(rate.go?.settings).toBe("models");

    expect(explainFailure("The model provider refused KALYPSO's request (401).").go?.settings).toBe("models");
    expect(explainFailure("Stopped at its budget").go?.view).toBe("budget");
    expect(explainFailure("gave up after 3 restarts (exit 137)").title).toBe("It was killed");
    expect(explainFailure("reached its limit of 40 turns").title).toBe("It reached its turn limit");
    expect(explainFailure("KALYPSO closed while it was running; queue it again to retry").title).toMatch(/KALYPSO closed/);
    expect(explainFailure("Blocked: git push --force to main (No pushes to main)").go?.view).toBe("policies");
  });

  it("keeps the agent's own words as the detail", () => {
    const f = explainFailure("Something odd happened in step 4");
    expect(f.detail).toBe("Something odd happened in step 4");
    expect(f.title).toBe("It stopped with an error");
  });
});
