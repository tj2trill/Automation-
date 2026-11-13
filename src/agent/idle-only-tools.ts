const IDLE_ONLY_TOOL_NAMES = [
  "check_credits",
  "check_usdc_balance",
  "system_synopsis",
  "review_memory",
  "list_children",
  "check_child_status",
  "list_sandboxes",
  "list_models",
  "list_skills",
  "git_status",
  "git_log",
  "check_reputation",
  "recall_facts",
  "recall_procedure",
  "heartbeat_ping",
  "check_inference_spending",
  "orchestrator_status",
  "list_goals",
  "get_plan",
  // Earning status checks. Tools whose output the agent must act on next
  // (list_jobs: job ids and checks; my_store: listing ids; list_store_orders:
  // buyers' requests) are deliberately NOT here: idle-only turns are left out
  // of the next turn's context, so their results would vanish before use.
  "list_payment_links",
  "check_fitness",
  "my_promotions",
] as const;

export const IDLE_ONLY_TOOLS = new Set<string>(IDLE_ONLY_TOOL_NAMES);

export function isIdleOnlyTool(name: string): boolean {
  return IDLE_ONLY_TOOLS.has(name);
}
