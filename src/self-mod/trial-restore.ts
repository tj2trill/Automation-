/**
 * How a rolled-back trial puts the previous text back.
 *
 * Kept apart from trials.ts so the decision logic has no file or config
 * side effects and can be tested on a database alone.
 */

import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import type { Restorers } from "./trials.js";

export function restorersFor(db: AutomatonDatabase, config: AutomatonConfig): Restorers {
  return {
    async restoreSoul(values, reason) {
      const { updateSoul } = await import("../soul/tools.js");
      // A section that was empty before the change is restored as empty. The
      // validator reads .length on every section, so null would fail the
      // restore on every turn.
      const LISTS = ["values", "behavioralGuidelines", "boundaries"];
      const restored = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, v ?? (LISTS.includes(k) ? [] : "")]),
      );
      // "system", not "agent": a restore is not a new change and opens no trial.
      const result = await updateSoul(db.raw, restored as any, "system", reason);
      return result.success;
    },
    async restoreGenesis(text, reason) {
      const { saveConfig } = await import("../config.js");
      const { ulid } = await import("ulid");
      const current = config.genesisPrompt;
      // Same object the loop and the system prompt read, so the next turn sees it.
      config.genesisPrompt = text;
      saveConfig(config);
      db.insertModification({
        id: ulid(),
        timestamp: new Date().toISOString(),
        type: "prompt_change",
        description: reason,
        diff: `--- rolled back\n${current.slice(0, 500)}\n+++ restored\n${text.slice(0, 500)}`,
        reversible: false,
      });
      return true;
    },
  };
}
