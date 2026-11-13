/**
 * Where the system prompt's stable instructions end and the per-turn state
 * begins. Clients that support prompt caching cache everything before it.
 */
export const SYSTEM_PROMPT_CACHE_SPLIT = "\n\n--- CURRENT STATE (changes from turn to turn) ---\n\n";
