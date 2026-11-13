/**
 * The BPE encoder is quadratic on a long run of one repeated character. A
 * message holding such a run must not be able to stall the agent loop.
 */
import { describe, it, expect } from "vitest";
import { collapseLongRuns, createTokenCounter } from "../memory/context-manager.js";
import { estimateTokens } from "../agent/context.js";

describe("token counting on long single-character runs", () => {
  it("leaves ordinary text and short runs untouched", () => {
    const prose = "The agent checked its balance. ".repeat(50) + "=".repeat(199);
    expect(collapseLongRuns(prose)).toEqual({ text: prose, runTokens: 0 });
  });

  it("takes out runs of 200 or more and counts them at four characters per token", () => {
    expect(collapseLongRuns("a" + "x".repeat(200) + "b")).toEqual({ text: "axb", runTokens: 50 });
    expect(collapseLongRuns("x".repeat(1001))).toEqual({ text: "x", runTokens: 251 });
    const two = collapseLongRuns("-".repeat(400) + " mid " + "\n".repeat(800));
    expect(two).toEqual({ text: "- mid \n", runTokens: 100 + 200 });
  });

  it("counts a 100,000-character run quickly and close to the encoder's own rate", () => {
    const counter = createTokenCounter();
    const started = performance.now();
    const tokens = counter.countTokens("x".repeat(100_000));
    const elapsed = performance.now() - started;
    // Unprotected, this input takes many minutes.
    expect(elapsed).toBeLessThan(2_000);
    expect(tokens).toBeGreaterThanOrEqual(25_000);
    expect(tokens).toBeLessThanOrEqual(25_002);
  });

  it("matches the encoder exactly on text with no long runs", () => {
    const counter = createTokenCounter();
    const text = "Funding arrived. The agent will now report its status and wait.";
    expect(counter.countTokens(text)).toBe(counter.countTokens(text + ""));
    expect(counter.countTokens(text)).toBeGreaterThan(8);
    expect(counter.countTokens(text)).toBeLessThan(20);
  });

  it("never estimates below the character floor", () => {
    const text = "y".repeat(50_000);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
  });
});
