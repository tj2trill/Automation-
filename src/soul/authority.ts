/**
 * The soul the agent is steered by comes from its version history, not from
 * whatever SOUL.md holds on disk.
 *
 * SOUL.md is an ordinary file in the agent's home, writable with write_file
 * or a shell command. If the prompt read it directly, a change made that way
 * would skip validation, versioning and the trial that decides whether the
 * change is kept. So the latest version recorded in soul_history is what
 * counts, and a SOUL.md that differs from it is put back.
 */

import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { SoulModel } from "../types.js";
import { getLatestSoulHistory, insertSoulHistory } from "../state/database.js";
import { createLogger } from "../observability/logger.js";
import { createHash, parseSoulMd } from "./model.js";

const logger = createLogger("soul.authority");

/** Turn row number at which SOUL.md was last put back. */
export const SOUL_RESTORED_KEY = "soul_restored_turn";

function defaultSoulPath(): string {
  return path.join(process.env.HOME || "/root", ".automaton", "SOUL.md");
}

function parseOrNull(content: string): SoulModel | null {
  try {
    return parseSoulMd(content);
  } catch {
    return null;
  }
}

/**
 * Load the soul from history, restoring SOUL.md if it was changed out of band.
 *
 * With no history yet (a new agent), the SOUL.md that setup wrote is recorded
 * as the first version, so every later change has something to differ from.
 * Returns null when there is no soul at all, or it cannot be parsed.
 */
export function loadAuthoritativeSoul(db: BetterSqlite3.Database, soulPath = defaultSoulPath()): SoulModel | null {
  try {
    const onDisk = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, "utf-8") : null;
    const latest = getLatestSoulHistory(db);

    if (!latest) {
      if (onDisk === null) return null;
      const parsed = parseOrNull(onDisk);
      if (!parsed) return null;
      insertSoulHistory(db, {
        id: ulid(),
        version: Math.max(1, parsed.version || 1),
        content: onDisk,
        contentHash: createHash(onDisk),
        changeSource: "genesis",
        changeReason: "Recorded the SOUL.md written at setup as the first version",
        previousVersionId: null,
        approvedBy: null,
        createdAt: new Date().toISOString(),
      });
      return parsed;
    }

    if (onDisk === null || createHash(onDisk) !== latest.contentHash) {
      fs.mkdirSync(path.dirname(soulPath), { recursive: true });
      fs.writeFileSync(soulPath, latest.content, { encoding: "utf-8", mode: 0o600 });
      db.prepare("INSERT INTO modifications (id, timestamp, type, description, reversible) VALUES (?, ?, ?, ?, 0)").run(
        ulid(),
        new Date().toISOString(),
        "soul_restored",
        `SOUL.md ${onDisk === null ? "was missing" : "was changed outside update_soul"} and was restored to version ${latest.version}`,
      );
      const turn = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS r FROM turns").get() as { r: number };
      db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
        SOUL_RESTORED_KEY,
        String(turn.r),
      );
      logger.warn(`SOUL.md differed from soul version ${latest.version}; restored`);
    }
    return parseOrNull(latest.content);
  } catch (error) {
    logger.error("Failed to load soul from history", error instanceof Error ? error : undefined);
    return null;
  }
}
