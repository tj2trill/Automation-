/*
 * Automaton host dashboard.
 *
 * Every piece of text that comes from the host is written with textContent.
 * Agent names, log lines, ledger notes and messages are text an agent
 * controls, so nothing here ever builds HTML from data.
 */
"use strict";

const TIERS = [
  { id: "critical", label: "Critical", from: 0, to: 10 },
  { id: "low_compute", label: "Low compute", from: 10, to: 50 },
  { id: "normal", label: "Normal", from: 50, to: 500 },
  { id: "high", label: "High", from: 500, to: 5000 },
];
const TIER_NAMES = { dead: "Dead", critical: "Critical", low_compute: "Low compute", normal: "Normal", high: "High" };
const KIND_NAMES = {
  topup: "Funding", inference: "Inference", compute: "Compute",
  transfer_out: "Transfer out", transfer_in: "Transfer in", adjustment: "Adjustment",
  job_reward: "Job reward", sale: "Sale",
};
const JOB_STATUS = { open: "Open", paid: "Paid", cancelled: "Cancelled", expired: "Expired" };
const PAYMENT_STATUS = { open: "Waiting for customer", paid: "Paid", expired: "Expired", paid_after_death: "Paid after the agent died (kept by you)" };
const TOKEN_KEY = "automaton-host-token";

const state = {
  token: null,
  overview: null,
  open: {},        // address -> "log" | "ledger" | "message"
  confirming: {},  // address or sandbox id -> true while a remove awaits confirmation
  drafts: {},      // address -> unsent message text
  fundDrafts: {},  // address -> amount typed but not submitted
  logs: {},        // address -> last loaded log text
  ledgers: {},     // address -> last loaded entries
  timer: null,
  busy: false,
  jobs: [],
  payments: [],
  stripeEnabled: false,
  confirmingJob: {}, // job id -> true while a cancel awaits confirmation
  stores: null,
  confirmingRefund: {}, // order id -> true while a refund awaits confirmation
  confirmingCancel: {}, // subscription order id -> true while a cancel awaits confirmation
};
const ORDER_STATUS = {
  paid: "Paid", paid_after_death: "Paid after the agent died", refunded: "Refunded",
  awaiting_delivery: "Waiting for the agent", refunding: "Refunding", delivered: "Delivered",
  fulfilling: "Sent to Printful", subscribed: "Subscribed", canceled: "Subscription ended",
};
const KIND_LABEL = { file: "Download", service: "Made to order", subscription: "Subscription", print: "Print" };

// ─── Small helpers ─────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "on") for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else if (k in node && k !== "list") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function usd(micro, digits) {
  const v = micro / 1e6;
  const d = digits !== undefined ? digits : v !== 0 && Math.abs(v) < 0.0001 ? 6 : Math.abs(v) < 1 && v !== 0 ? 4 : 2;
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(d);
}

function shortAddr(a) {
  return a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
}

function timeOf(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function readStoredToken() {
  try { return window.localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}
function storeToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* private mode: the token then lives for this page only */ }
}

function say(message, isError) {
  const s = $("status");
  s.textContent = message;
  s.hidden = !message;
  s.classList.toggle("is-error", !!isError);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: Object.assign({ "X-Admin-Token": state.token || "" }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (res.status === 401) {
    const err = new Error((data && data.error) || "Not signed in");
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
  return data;
}

/** Run one action: disable its button, report the outcome, refresh. */
async function act(button, doing, fn, done) {
  if (button) button.disabled = true;
  say(doing);
  try {
    const result = await fn();
    await refresh();
    say(typeof done === "function" ? done(result) : done);
    return result;
  } catch (err) {
    if (err.unauthorized) return showConnect(err.message);
    say(err.message, true);
    if (button && button.isConnected) button.disabled = false;
    return undefined;
  }
}

// ─── Rendering ─────────────────────────────────────────────────

function runway(agent) {
  const cents = agent.balanceMicro / 10000;
  // Each tier gets an equal quarter of the track, so the small-dollar tiers
  // that matter most for survival are not squeezed into the first pixel.
  let pos = 0;
  if (cents > 0) {
    const i = TIERS.findIndex((t) => cents <= t.to);
    if (i === -1) pos = 100;
    else pos = (i + (cents - TIERS[i].from) / (TIERS[i].to - TIERS[i].from)) * 25;
  }
  pos = Math.max(0, Math.min(100, pos));
  const track = el("div", { class: "runway-track", "aria-hidden": "true" },
    TIERS.map(() => el("span")),
    el("div", { class: "runway-fill" }),
    el("div", { class: "runway-mark" }));
  // Set through the style object, not a style attribute: the page's content
  // security policy forbids inline style attributes.
  track.querySelector(".runway-fill").style.width = pos + "%";
  track.querySelector(".runway-mark").style.left = pos + "%";
  const scale = el("div", { class: "runway-scale", "aria-hidden": "true" },
    TIERS.map((t) => el("span", { class: agent.tier === t.id ? "on" : "", text: t.label + " from " + usd(t.from * 10000, 2) })));
  return el("div", { class: "runway", data: { tier: agent.tier }, role: "img",
    "aria-label": "Balance " + agent.balanceUsd + ", tier " + TIER_NAMES[agent.tier] }, track, scale);
}

function stateText(agent) {
  if (agent.frozen && agent.sandbox && agent.sandbox.state !== "running") return { text: "Stopped and frozen", down: true };
  if (agent.frozen) return { text: "Frozen: cannot spend or call the host", down: true };
  if (!agent.sandbox) return { text: "No container", down: false };
  if (agent.sandbox.state === "missing") return { text: "Container missing", down: true };
  if (agent.sandbox.state !== "running") return { text: "Container stopped", down: true };
  if (agent.sandbox.runtime !== "running") return { text: "Container up, agent process not running", down: true };
  return { text: "Running", down: false };
}

function detailPanel(agent) {
  const tab = state.open[agent.address];
  if (!tab) return null;
  const tabs = el("div", { class: "tabs", role: "group", "aria-label": "Details for " + agent.name },
    [["log", "Log"], ["ledger", "Ledger"], ["message", "Message"]].map(([id, label]) =>
      el("button", { type: "button", text: label, "aria-pressed": String(tab === id), data: { action: "tab-" + id },
        on: { click: () => openTab(agent, id) } })));

  let body;
  if (tab === "log") {
    const text = state.logs[agent.address];
    body = el("div", {},
      el("pre", { class: "log", tabIndex: 0, data: { role: "log" }, text: text === undefined ? "Loading…" : text || "The log is empty." }),
      el("div", { class: "detail-actions" },
        el("button", { type: "button", text: "Reload log", data: { action: "reload-log" }, on: { click: (e) => loadLog(agent, e.currentTarget) } })));
  } else if (tab === "ledger") {
    const entries = state.ledgers[agent.address];
    body = entries === undefined
      ? el("p", { class: "quiet", text: "Loading…" })
      : entries.length === 0
        ? el("p", { class: "empty", text: "No entries for this agent yet." })
        : el("div", { class: "table-wrap" }, ledgerTable(entries, false));
  } else {
    const box = el("textarea", { rows: 4, "aria-label": "Message to " + agent.name, data: { role: "message" },
      placeholder: "Sent as its creator. The agent reads it on its next inbox check.",
      value: state.drafts[agent.address] || "",
      on: { input: (e) => { state.drafts[agent.address] = e.target.value; } } });
    body = el("div", {}, box,
      el("div", { class: "detail-actions after-field" },
        el("button", { type: "button", class: "primary", text: "Send message", data: { action: "send" },
          on: { click: (e) => sendMessage(agent, e.currentTarget) } })));
  }
  return el("div", { class: "detail", data: { role: "detail" } }, tabs, body);
}

function agentRow(agent) {
  const st = stateText(agent);
  const isCreator = agent.role === "creator";
  const hasBox = !!agent.sandbox;
  const stopped = hasBox && agent.sandbox.state !== "running";
  const confirming = !!state.confirming[agent.address];

  const meta = el("div", { class: "agent-meta" },
    el("span", { text: agent.role === "child" ? "Child of " + shortAddr(agent.parent || "") : agent.role === "creator" ? "You (creator)" : agent.role === "agent" ? "Agent" : "Account" }),
    el("span", { class: "addr", title: agent.address, text: shortAddr(agent.address) }),
    el("button", { type: "button", text: "Copy address", data: { action: "copy" }, on: { click: (e) => copyAddress(agent, e.currentTarget) } }),
    hasBox ? el("span", { text: agent.sandbox.memoryMb + " MB" }) : null,
    el("span", { class: "state" + (st.down ? " is-down" : ""), data: { role: "state" }, text: st.text }));

  const head = el("div", { class: "agent-head" },
    el("div", {}, el("h3", { text: agent.name }), meta),
    el("div", { class: "balance", data: { role: "balance" } }, agent.balanceUsd,
      el("small", { text: isCreator ? "Not billed" : "Spent " + usd(agent.spentMicro) + " over " + agent.inferenceCalls + " model calls" })));

  const fundInput = el("input", { type: "number", min: "0.01", step: "0.01", inputMode: "decimal", placeholder: "5.00",
    "aria-label": "Amount to add to " + agent.name + ", USD", data: { role: "fund-amount" },
    value: state.fundDrafts[agent.address] || "",
    on: { input: (e) => { state.fundDrafts[agent.address] = e.target.value; } } });
  const fund = el("form", { class: "fund", on: { submit: (e) => { e.preventDefault(); fundAgent(agent, fundInput, e.submitter); } } },
    fundInput, el("button", { type: "submit", text: "Add funds", data: { action: "fund" } }));

  const actions = el("div", { class: "agent-actions" }, fund);
  if (!isCreator) {
    actions.append(
      agent.frozen && !stopped
        ? el("button", { type: "button", text: "Unfreeze", data: { action: "unfreeze" }, on: { click: (e) => simple(agent, "unfreeze", "Unfreezing", "Unfroze", e.currentTarget) } })
        : !agent.frozen
          ? el("button", { type: "button", text: "Freeze", data: { action: "freeze" }, on: { click: (e) => simple(agent, "freeze", "Freezing", "Froze", e.currentTarget) } })
          : "",
    );
    if (hasBox) {
      actions.append(stopped || agent.sandbox.runtime !== "running"
        ? el("button", { type: "button", text: "Start", data: { action: "start" }, on: { click: (e) => simple(agent, "start", "Starting", "Started", e.currentTarget) } })
        : el("button", { type: "button", text: "Stop", data: { action: "stop" }, on: { click: (e) => simple(agent, "stop", "Stopping", "Stopped", e.currentTarget) } }));
    }
    actions.append(
      el("button", { type: "button", text: state.open[agent.address] ? "Close details" : "Open details", data: { action: "details" },
        "aria-expanded": String(!!state.open[agent.address]), on: { click: () => toggleDetails(agent) } }),
      el("span", { class: "spacer" }));
    if (confirming) {
      actions.append(
        el("span", { class: "error", text: "Remove " + agent.name + "? This deletes its containers and revokes its key." }),
        el("button", { type: "button", class: "danger confirm", text: "Remove agent", data: { action: "remove-confirm" }, on: { click: (e) => removeAgent(agent, e.currentTarget) } }),
        el("button", { type: "button", text: "Keep agent", data: { action: "remove-cancel" }, on: { click: () => { delete state.confirming[agent.address]; render(); } } }));
    } else {
      actions.append(el("button", { type: "button", class: "danger", text: "Remove", data: { action: "remove" },
        on: { click: () => { state.confirming[agent.address] = true; render(); } } }));
    }
  }

  return el("article", { class: "agent", data: { address: agent.address, name: agent.name, tier: agent.tier } },
    head, isCreator ? null : runway(agent), actions, isCreator ? null : detailPanel(agent));
}

function ledgerTable(entries, withAccount) {
  const names = {};
  for (const a of (state.overview && state.overview.agents) || []) names[a.address] = a.name;
  const head = el("tr", {},
    el("th", { text: "Time" }), withAccount ? el("th", { text: "Account" }) : null, el("th", { text: "Type" }),
    el("th", { class: "num", text: "Amount" }), el("th", { class: "num", text: "Balance after" }), el("th", { text: "Note" }));
  const rows = entries.map((e) => el("tr", {},
    el("td", { text: timeOf(e.ts) }),
    withAccount ? el("td", { text: names[e.address] || shortAddr(e.address) }) : null,
    el("td", { text: KIND_NAMES[e.kind] || e.kind }),
    el("td", { class: "num " + (e.deltaMicro < 0 ? "neg" : "pos"), text: (e.deltaMicro > 0 ? "+" : "") + usd(e.deltaMicro, 4) }),
    el("td", { class: "num", text: usd(e.balanceAfterMicro, 4) }),
    el("td", { text: e.note || "" })));
  return el("table", {}, el("thead", {}, head), el("tbody", {}, rows));
}

function render() {
  const o = state.overview;
  if (!o) return;
  $("connect").hidden = true;
  $("app").hidden = false;
  $("updated").textContent = "Updated " + new Date(o.generatedAt).toLocaleTimeString();

  const t = o.totals;
  const money = $("money");
  money.replaceChildren(
    "You have funded ", el("strong", { text: usd(t.fundedMicro, 2) }), ". Agents spent ",
    el("strong", { text: usd(t.inferenceMicro) }), " on inference and ",
    el("strong", { text: usd(t.computeMicro) }), " on compute and earned ",
    el("strong", { text: usd(o.economy.earnedMicro) }), " from jobs and customers. ",
    el("strong", { text: usd(t.balanceMicro, 2) }), " is still held.");
  $("audit").textContent = (o.ledgerAudit.ok
    ? "Ledger checked: every balance equals the sum of its entries."
    : "Ledger mismatch on " + o.ledgerAudit.mismatches + " account(s). Run automaton-host ledger.")
    + " Containers in use: " + t.sandboxes + " of " + t.sandboxLimit + ".";

  // Keep focus and typing position across the periodic re-render.
  const active = document.activeElement;
  const focusKey = active && active.closest(".agent") && active.dataset.role
    ? { address: active.closest(".agent").dataset.address, role: active.dataset.role, start: active.selectionStart, end: active.selectionEnd }
    : null;

  const shown = o.agents.filter((a) => a.role !== "creator" || a.balanceMicro !== 0);
  $("agents").replaceChildren(...shown.map(agentRow));
  $("no-agents").hidden = shown.length > 0;

  if (focusKey) {
    const row = document.querySelector('.agent[data-address="' + focusKey.address + '"]');
    const target = row && row.querySelector('[data-role="' + focusKey.role + '"]');
    if (target) {
      target.focus();
      try { if (focusKey.start !== null && target.setSelectionRange) target.setSelectionRange(focusKey.start, focusKey.end); } catch (_) { /* number inputs have no selection */ }
    }
  }

  $("orphans-section").hidden = o.orphanSandboxes.length === 0;
  $("orphans").replaceChildren(...o.orphanSandboxes.map((s) => {
    const confirming = !!state.confirming[s.id];
    return el("div", { class: "orphan", data: { sandbox: s.id } },
      el("span", {}, el("strong", { text: s.name }), " ", el("span", { class: "quiet", text: s.memoryMb + " MB, " + s.state + ", created by " + shortAddr(s.owner) })),
      el("span", { class: "detail-actions" }, confirming
        ? [el("button", { type: "button", class: "danger confirm", text: "Remove container", data: { action: "orphan-remove-confirm" }, on: { click: (e) => removeSandbox(s, e.currentTarget) } }),
           el("button", { type: "button", text: "Keep container", data: { action: "orphan-remove-cancel" }, on: { click: () => { delete state.confirming[s.id]; render(); } } })]
        : el("button", { type: "button", class: "danger", text: "Remove", data: { action: "orphan-remove" }, on: { click: () => { state.confirming[s.id] = true; render(); } } })));
  }));

  const roleNames = { primary: "Normal and high", low_compute: "Low compute", critical: "Critical" };
  $("models").tBodies[0].replaceChildren(...o.models.map((m) => el("tr", {},
    el("td", { text: m.id }),
    el("td", { text: m.upstream === "ollama" ? "This machine (Ollama)" : m.upstream === "anthropic" ? "Anthropic API" : "OpenAI-compatible API" }),
    el("td", { text: m.roles.map((r) => roleNames[r] || r).join(", ") || "On request" }),
    el("td", { class: "num", text: "$" + m.inputPerMillionUsd.toFixed(2) }),
    el("td", { class: "num", text: "$" + m.outputPerMillionUsd.toFixed(2) }),
    el("td", { class: "num", text: String(m.calls) }),
    el("td", { class: "num", text: usd(m.costMicro) }))));

  renderEconomy();

  const filter = $("ledger-filter");
  const wanted = filter.value;
  filter.replaceChildren(el("option", { value: "", text: "all accounts" }),
    ...o.agents.map((a) => el("option", { value: a.address, text: a.name })));
  filter.value = o.agents.some((a) => a.address === wanted) ? wanted : "";
}

function renderEconomy() {
  const e = state.overview.economy;
  $("selection-rules").textContent = "Each child needs " + usd(e.spawnProfitUsd * 1e6, 2) +
    " of earned profit (jobs and sales minus the agent's own spending), so a second child needs twice that. " +
    "An agent at $0 for " + e.deathGraceMinutes + " minutes is deleted for good. " +
    (e.mustEarnAfterDays > 0
      ? "After its first " + e.mustEarnAfterDays + " days an agent lives only on earned profit: once that is $0 or less it is deleted, whatever its balance. Funding buys time, not survival. "
      : "") +
    "Alive: " + e.alive + ". Dead: " + e.dead + ".";
  $("standings").tBodies[0].replaceChildren(...e.standings.map((s) => el("tr", { class: s.alive ? "" : "is-dead" },
    el("td", { text: s.name }),
    el("td", { text: s.death ? "Dead since " + timeOf(s.death.at) + " (" + s.death.reason + ")"
      : s.diesAt ? (s.starvingReason === "not earning" ? "Not earning: dies " : "Out of money: dies ") + timeOf(s.diesAt)
      : s.mustEarnBy && s.profitMicro <= 0 ? "Must earn by " + timeOf(s.mustEarnBy) : "Alive" }),
    el("td", { class: "num", text: String(s.generation) }),
    el("td", { class: "num", text: String(s.children) }),
    el("td", { class: "num pos", text: usd(s.earnedMicro) }),
    el("td", { class: "num", text: usd(s.spentMicro) }),
    el("td", { class: "num " + (s.profitMicro < 0 ? "neg" : "pos"), text: usd(s.profitMicro) }),
    el("td", { class: "num", text: s.alive ? usd(s.balanceMicro) : "" }))));
  $("standings").hidden = e.standings.length === 0;
  $("no-standings").hidden = e.standings.length > 0;

  renderStores();
  renderEmail();
  renderSites();
  $("jobs").replaceChildren(...state.jobs.map(jobRow));
  $("no-jobs").hidden = state.jobs.length > 0;

  $("stripe-state").textContent = state.stripeEnabled
    ? "Stripe is on. Paid links are credited to the agent, less fees, within a minute, or now with the button."
    : "Stripe is off. Set STRIPE_SECRET_KEY before running serve to let agents take customer payments.";
  $("check-payments").disabled = !state.stripeEnabled;
  $("payments").tBodies[0].replaceChildren(...state.payments.map((p) => el("tr", {},
    el("td", { text: timeOf(p.createdAt) }),
    el("td", { text: p.name }),
    el("td", { text: p.description }),
    el("td", { class: "num", text: usd(p.amountCents * 1e4, 2) }),
    el("td", { text: PAYMENT_STATUS[p.status] || p.status }),
    el("td", { class: "num", text: p.netMicro === null ? "" : usd(p.netMicro, 4) }))));
  $("payments").hidden = state.payments.length === 0;
  $("no-payments").hidden = state.payments.length > 0;
}

function renderStores() {
  const s = state.stores;
  if (!s) return;
  $("stores-state").textContent = (s.publicUrl ? "Published at " + s.publicUrl + ". " : "Not published: set storefront.publicUrl and run a Cloudflare Tunnel to it. ") +
    (s.missingForSales.length ? "Purchases are off until you set: " + s.missingForSales.join(", ") + "." : "Purchases are on. Listings go live as soon as an agent makes them; pull anything you would not sell yourself.") +
    (s.printEnabled ? " Print-on-demand is on." : " Print-on-demand is off.");
  $("stores").replaceChildren(...s.stores.map((st) => {
    const items = s.listings.filter((l) => l.address === st.address);
    return el("div", { class: "store", data: { store: st.address } },
      el("div", { class: "store-head" },
        el("span", {}, el("strong", { text: st.name }), " ",
          el("span", { class: "quiet", text: (st.dead ? "dead, store closed" : st.suspended ? "suspended by you" : "open") + (st.url ? " · " + st.url : "") })),
        st.dead ? null : el("button", { type: "button", class: st.suspended ? "" : "danger", text: st.suspended ? "Reopen store" : "Suspend store",
          data: { action: st.suspended ? "store-resume" : "store-suspend" },
          on: { click: (e) => storeAction(st, st.suspended ? "resume" : "suspend", e.currentTarget) } })),
      ...items.map((l) => el("div", { class: "listing", data: { listing: l.id } },
        el("div", { class: "job-main" },
          el("strong", { text: l.title }),
          el("p", { class: "quiet", text: KIND_LABEL[l.kind] + " · " + usd(l.priceCents * 1e4, 2) + (l.kind === "subscription" ? "/month" : "") +
            (l.kind === "file" ? " · " + l.filename : l.kind === "service" ? " · within " + l.deliveryHours + "h" : l.kind === "print" ? " · " + l.podProduct : "") +
            " · " + (l.pulled ? "pulled by you" : !l.live ? "off (agent)" : l.onSale ? "on sale" : "not on sale") +
            " · " + l.sales.count + " sold" + (l.kind === "subscription" ? ", " + l.sales.subscribers + " subscribed" : "") +
            (l.kind === "service" && l.sales.waiting ? ", " + l.sales.waiting + " waiting" : "") +
            ", " + usd(l.sales.netMicro, 2) + " to the agent" }),
          el("p", { class: "desc", text: l.description })),
        el("button", { type: "button", class: l.pulled ? "" : "danger", text: l.pulled ? "Put back" : "Pull",
          data: { action: l.pulled ? "listing-restore" : "listing-pull" },
          on: { click: (e) => listingAction(l, l.pulled ? "restore" : "pull", e.currentTarget) } }))));
  }));
  $("no-stores").hidden = s.stores.length > 0;
  $("orders").tBodies[0].replaceChildren(...s.orders.map((o) => {
    const confirming = !!state.confirmingRefund[o.id];
    const canRefund = ["paid", "paid_after_death", "delivered", "fulfilling", "awaiting_delivery"].includes(o.status);
    const canCancel = o.status === "subscribed";
    let action = null;
    if (canRefund) {
      action = confirming
        ? [el("button", { type: "button", class: "danger confirm", text: "Refund buyer", data: { action: "refund-confirm" }, on: { click: (e) => refundOrder(o, e.currentTarget) } }),
           el("button", { type: "button", text: "Keep", data: { action: "refund-keep" }, on: { click: () => { delete state.confirmingRefund[o.id]; render(); } } })]
        : el("button", { type: "button", text: "Refund", data: { action: "refund" }, on: { click: () => { state.confirmingRefund[o.id] = true; render(); } } });
    } else if (canCancel) {
      action = state.confirmingCancel[o.id]
        ? [el("button", { type: "button", class: "danger confirm", text: "End subscription", data: { action: "sub-cancel-confirm" }, on: { click: (e) => cancelSub(o, e.currentTarget) } }),
           el("button", { type: "button", text: "Keep", data: { action: "sub-cancel-keep" }, on: { click: () => { delete state.confirmingCancel[o.id]; render(); } } })]
        : el("button", { type: "button", text: "Cancel", data: { action: "sub-cancel" }, on: { click: () => { state.confirmingCancel[o.id] = true; render(); } } });
    }
    const detail = o.kind === "service" && o.status === "awaiting_delivery" ? " · due " + timeOf(o.dueAt)
      : o.kind === "print" && o.printfulOrderId ? " · Printful " + o.printfulOrderId + (o.variantLabel ? " · " + o.variantLabel : "")
      : o.note ? " · " + o.note : "";
    return el("tr", { data: { order: o.id } },
      el("td", { text: o.paidAt ? timeOf(o.paidAt) : "" }),
      el("td", { text: o.name }),
      el("td", { text: KIND_LABEL[o.kind] + ": " + o.title + detail }),
      el("td", { class: "num", text: usd(o.amountCents * 1e4, 2) }),
      el("td", { class: "num", text: o.netMicro === null ? "" : usd(o.netMicro, 4) }),
      el("td", { text: ORDER_STATUS[o.status] || o.status }),
      el("td", {}, action));
  }));
  $("orders").hidden = s.orders.length === 0;
  $("no-orders").hidden = s.orders.length > 0;

  const drafts = s.promotions;
  $("promotions").replaceChildren(...drafts.map((p) => el("div", { class: "job", data: { promotion: p.id } },
    el("div", { class: "job-main" },
      el("strong", { text: p.name + " · " + p.platform }),
      el("p", { class: "quiet", text: (p.status === "posted" ? "Posted" : "Draft, not posted") + " · " + p.views + " visits, " + p.sales + " sales" }),
      el("p", { class: "desc", text: p.text }),
      p.link ? el("p", { class: "mono", text: p.link }) : null),
    el("span", { class: "detail-actions" },
      el("button", { type: "button", text: "Copy post", data: { action: "promo-copy" }, on: { click: (e) => copyPromotion(p, e.currentTarget) } }),
      p.status === "draft"
        ? [el("button", { type: "button", class: "primary", text: "Mark posted", data: { action: "promo-posted" }, on: { click: (e) => promotionAction(p, "posted", e.currentTarget) } }),
           el("button", { type: "button", class: "danger", text: "Discard", data: { action: "promo-discard" }, on: { click: (e) => promotionAction(p, "discarded", e.currentTarget) } })]
        : el("button", { type: "button", text: "Back to drafts", data: { action: "promo-draft" }, on: { click: (e) => promotionAction(p, "draft", e.currentTarget) } })))));
  $("no-promotions").hidden = drafts.length > 0;
}

const THREAD_STATUS = { open: "no reply yet", replied: "replied", unsubscribed: "unsubscribed", bounced: "bounced", closed: "closed" };

function renderEmail() {
  const e = state.email;
  if (!e) return;
  $("email-state").textContent = e.enabled
    ? "Agents send from " + e.fromAddress + ". Today " + e.stats.sentToday + " of " + e.stats.perDay + " sent. " +
      e.stats.contacted + (e.stats.contacted === 1 ? " business" : " businesses") + " contacted, " + e.stats.replied + " replied, " + e.stats.unsubscribed + " unsubscribed, " + e.stats.bounced + " bounced." +
      (e.paused ? " All email is paused." : "")
    : "Email is off until you set: " + e.missing.join(", ") + ".";
  const all = $("email-pause-all");
  all.textContent = e.paused ? "Resume all email" : "Pause all email";
  all.className = e.paused ? "" : "danger";
  all.disabled = !e.enabled;
  $("email-agents").replaceChildren(...e.agents.map((a) => el("div", { class: "store-head", data: { emailAgent: a.address } },
    el("span", {}, el("strong", { text: a.name }), " ",
      el("span", { class: "quiet", text: a.sentToday + " of " + a.perDay + " today · " + a.contacted + " contacted · " + a.replied + " replied · " + a.unsubscribed + " unsubscribed" + (a.paused ? " · paused" : "") })),
    e.paused ? null : el("button", { type: "button", class: a.paused ? "" : "danger", text: a.paused ? "Resume" : "Pause",
      on: { click: (ev) => pauseEmail(a.address, a.name, !a.paused, ev.currentTarget) } }))));
  state.emailOpen = state.emailOpen || {};
  $("email-threads").replaceChildren(...e.threads.map((t) => {
    const open = state.emailOpen[t.id];
    return el("div", { class: "job", data: { thread: t.id } },
      el("div", { class: "job-main" },
        el("strong", { text: t.subject }),
        el("p", { class: "quiet", text: t.name + " → " + t.contact + " · " + (THREAD_STATUS[t.status] || t.status) + " · " + timeOf(t.lastInAt || t.lastOutAt || t.createdAt) }),
        open ? el("div", { class: "thread" }, ...open.messages.map((m) => el("div", { class: "msg " + m.direction },
          el("p", { class: "quiet", text: (m.direction === "out" ? t.name : m.automatic ? "Automatic reply" : t.contact) + " · " + timeOf(m.at) }),
          el("p", { class: "desc", text: m.body })))) : null),
      el("span", { class: "detail-actions" },
        el("button", { type: "button", text: open ? "Hide" : "Read", on: { click: (ev) => toggleThread(t, ev.currentTarget) } }),
        ["unsubscribed", "bounced", "closed"].includes(t.status) ? null
          : el("button", { type: "button", class: "danger", text: "Block", on: { click: (ev) => blockEmail(t.contact, ev.currentTarget) } })));
  }));
  $("no-email").hidden = e.threads.length > 0;
  $("email-suppressed-count").textContent = String(e.suppressed.length);
  $("email-suppressed").replaceChildren(...e.suppressed.map((x) => el("li", {},
    el("span", { class: "mono", text: x.key }), " ", el("span", { class: "quiet", text: x.reason + " · " + timeOf(x.at) }), " ",
    x.reason.startsWith("unsubscribed") ? null : el("button", { type: "button", text: "Unblock", on: { click: (ev) => unblockEmail(x.key, ev.currentTarget) } }))));
}

async function toggleThread(t, button) {
  if (state.emailOpen[t.id]) {
    delete state.emailOpen[t.id];
    render();
    return;
  }
  button.disabled = true;
  try {
    state.emailOpen[t.id] = await api("GET", "/api/email/threads/" + t.id);
    render();
  } catch (err) {
    say("Could not open that conversation: " + err.message);
  } finally {
    button.disabled = false;
  }
}

function pauseEmail(agent, name, paused, button) {
  return act(button, (paused ? "Pausing " : "Resuming ") + name + "'s email…", () => api("POST", "/api/email/pause", { agent, paused }),
    paused ? "Paused. " + name + " cannot send email until you resume it." : "Resumed " + name + "'s email.");
}

function blockEmail(key, button) {
  return act(button, "Blocking " + key + "…", () => api("POST", "/api/email/block", { key }), "Blocked. No agent will email " + key + ".");
}

function unblockEmail(key, button) {
  return act(button, "Unblocking " + key + "…", () => api("POST", "/api/email/unblock", { key }), "Unblocked " + key + ".");
}

const SITE_STATUS = { draft: "preview only", awaiting_payment: "waiting for the client to pay", live: "live, paid monthly", ended: "ended" };

function renderSites() {
  const s = state.sites;
  if (!s) return;
  $("sites-state").textContent = s.publicUrl
    ? "Client sites are served at " + s.publicUrl + ". A site is public only while its client pays for hosting; take down anything you would not host yourself."
    : "Not published: set sites.publicUrl to its own tunnel hostname (run `automaton-host sites tunnel`).";
  $("client-sites").replaceChildren(...s.sites.map((x) => el("div", { class: "job", data: { site: x.slug } },
    el("div", { class: "job-main" },
      el("strong", { text: x.title }),
      el("p", { class: "quiet", text: x.name + " · " + (SITE_STATUS[x.status] || x.status) + (x.priceCents ? " · " + usd(x.priceCents * 1e4, 2) + "/month" : "") +
        (x.clientEmail ? " · " + x.clientEmail : "") + " · " + x.files + " files" + (x.pulled ? " · taken down by you" : "") }),
      x.previewUrl ? el("p", { class: "mono", text: x.status === "live" ? x.liveUrl : x.previewUrl }) : null),
    el("button", { type: "button", class: x.pulled ? "" : "danger", text: x.pulled ? "Put back" : "Take down",
      on: { click: (ev) => act(ev.currentTarget, (x.pulled ? "Putting back " : "Taking down ") + x.slug + "…",
        () => api("POST", "/api/sites/" + x.slug + "/" + (x.pulled ? "up" : "down"), {}),
        x.pulled ? "Put back " + x.slug + "." : "Took down " + x.slug + ". It is offline, preview included.") } }))));
  $("no-sites").hidden = s.sites.length > 0;
}

async function copyPromotion(p, button) {
  const text = p.link ? p.text + "\n\n" + p.link : p.text;
  if (await copyText(text)) say("Copied the post and its link. Paste it where it belongs, then mark it posted.");
  else say("Could not copy on this device. Select the text and link above instead.");
  button.focus();
}

function promotionAction(p, status, button) {
  const words = { posted: ["Marking posted…", "Marked posted. Visits and sales through its link are counted for " + p.name + "."],
    discarded: ["Discarding…", "Discarded. " + p.name + " can see it was discarded."],
    draft: ["Moving back to drafts…", "Moved back to drafts."] }[status];
  return act(button, words[0], () => api("POST", "/api/promotions/" + p.id + "/" + status, {}), words[1]);
}

function cancelSub(o, button) {
  return act(button, "Ending " + o.title + " subscription…", async () => {
    const r = await api("POST", "/api/orders/" + o.id + "/cancel-subscription", {});
    delete state.confirmingCancel[o.id];
    return r;
  }, "Ended the subscription. The buyer is not charged again.");
}

function storeAction(st, verb, button) {
  return act(button, (verb === "suspend" ? "Suspending " : "Reopening ") + st.name + "'s store…",
    () => api("POST", "/api/stores/" + st.address + "/" + verb, {}),
    verb === "suspend" ? "Suspended " + st.name + "'s store. Nothing in it can be bought." : "Reopened " + st.name + "'s store.");
}

function listingAction(l, verb, button) {
  return act(button, (verb === "pull" ? "Pulling " : "Putting back ") + l.title + "…",
    () => api("POST", "/api/listings/" + l.id + "/" + verb, {}),
    verb === "pull" ? "Pulled " + l.title + ". The agent cannot put it back." : "Put " + l.title + " back on sale.");
}

function refundOrder(o, button) {
  return act(button, "Refunding " + o.title + "…", async () => {
    const r = await api("POST", "/api/orders/" + o.id + "/refund", {});
    delete state.confirmingRefund[o.id];
    return r;
  }, o.status === "awaiting_delivery"
    ? "Refunded " + o.title + " through Stripe. The agent had not been paid for it."
    : "Refunded " + o.title + " through Stripe and took back what " + o.name + " was paid for it.");
}

function jobRow(job) {
  const tries = job.submissions.length;
  const passes = job.submissions.filter((s) => s.passed).length;
  const confirming = !!state.confirmingJob[job.id];
  const summary = (JOB_STATUS[job.status] || job.status) + ". Reward " + usd(job.rewardMicro, 2) + ". " +
    tries + " attempt" + (tries === 1 ? "" : "s") + ", " + passes + " passed." +
    (job.winnerName ? " Won by " + job.winnerName + "." : "") +
    (job.deadlineAt && job.status === "open" ? " Closes " + timeOf(job.deadlineAt) + "." : "");
  return el("div", { class: "job", data: { job: job.id } },
    el("div", { class: "job-main" },
      el("strong", { text: job.title }),
      el("p", { class: "quiet", text: summary }),
      el("p", { class: "mono", text: "Check: " + job.check })),
    job.status !== "open" ? null : el("span", { class: "detail-actions" }, confirming
      ? [el("button", { type: "button", class: "danger confirm", text: "Cancel job", data: { action: "job-cancel-confirm" }, on: { click: (e) => cancelJob(job, e.currentTarget) } }),
         el("button", { type: "button", text: "Keep job", data: { action: "job-cancel-keep" }, on: { click: () => { delete state.confirmingJob[job.id]; render(); } } })]
      : el("button", { type: "button", class: "danger", text: "Cancel", data: { action: "job-cancel" }, on: { click: () => { state.confirmingJob[job.id] = true; render(); } } })));
}

function cancelJob(job, button) {
  return act(button, "Cancelling " + job.title + "…", async () => {
    const r = await api("POST", "/api/jobs/" + job.id + "/cancel", {});
    delete state.confirmingJob[job.id];
    return r;
  }, "Cancelled " + job.title + ". Nobody can be paid for it now.");
}

function checkPayments(button) {
  return act(button, "Asking Stripe about unpaid links…", () => api("POST", "/api/payments/check", {}),
    (r) => r.paid ? "Credited " + r.paid + " paid link" + (r.paid === 1 ? "" : "s") + "." : "No new payments.");
}

function openJob() {
  $("job-error").hidden = true;
  $("job-dialog").showModal();
  $("job-title").focus();
}

async function submitJob(e) {
  e.preventDefault();
  const form = $("job-form");
  if (!form.reportValidity()) return;
  const button = $("job-submit");
  const errorBox = $("job-error");
  errorBox.hidden = true;
  button.disabled = true;
  try {
    const r = await api("POST", "/api/jobs", {
      title: $("job-title").value,
      description: $("job-description").value,
      check: $("job-check").value,
      rewardUsd: Number($("job-reward").value),
      maxAttempts: $("job-attempts").value === "" ? undefined : Number($("job-attempts").value),
      deadlineHours: $("job-deadline").value === "" ? undefined : Number($("job-deadline").value),
    });
    $("job-dialog").close();
    form.reset();
    await refresh();
    say("Posted " + r.title + " for " + usd(r.rewardMicro, 2) + ".");
  } catch (err) {
    if (err.unauthorized) { $("job-dialog").close(); return showConnect(err.message); }
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function renderMainLedger(entries) {
  const table = $("ledger");
  const fresh = ledgerTable(entries, true);
  table.tHead.replaceWith(fresh.tHead);
  table.tBodies[0].replaceWith(fresh.tBodies[0]);
  table.hidden = entries.length === 0;
  $("no-ledger").hidden = entries.length > 0;
}

// ─── Actions ───────────────────────────────────────────────────

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    state.overview = await api("GET", "/api/overview");
    const [jobs, pays, stores, email, sites] = await Promise.all([
      api("GET", "/api/jobs"), api("GET", "/api/payments"), api("GET", "/api/stores"), api("GET", "/api/email"), api("GET", "/api/sites"),
    ]);
    state.stores = stores;
    state.email = email;
    state.sites = sites;
    state.jobs = jobs.jobs;
    state.payments = pays.payments;
    state.stripeEnabled = pays.stripeEnabled;
    render();
    const filter = $("ledger-filter").value;
    const led = await api("GET", "/api/ledger?limit=60" + (filter ? "&agent=" + encodeURIComponent(filter) : ""));
    renderMainLedger(led.entries);
    // Keep any open ledger tab current too.
    for (const [address, tab] of Object.entries(state.open)) {
      if (tab !== "ledger") continue;
      const r = await api("GET", "/api/ledger?limit=40&agent=" + encodeURIComponent(address));
      state.ledgers[address] = r.entries;
    }
    if (Object.values(state.open).includes("ledger")) render();
  } finally {
    state.busy = false;
  }
}

async function manualRefresh(button) {
  button.disabled = true;
  try {
    await refresh();
    say("Refreshed.");
  } catch (err) {
    if (err.unauthorized) showConnect(err.message); else say(err.message, true);
  } finally {
    button.disabled = false;
  }
}

function fundAgent(agent, input, button) {
  const amount = Number(input.value);
  if (!(amount > 0)) { say("Enter an amount above zero to add funds.", true); input.focus(); return; }
  return act(button, "Adding " + usd(amount * 1e6, 2) + " to " + agent.name + "…",
    async () => { const r = await api("POST", "/api/agents/" + agent.address + "/fund", { usd: amount }); delete state.fundDrafts[agent.address]; return r; },
    (r) => "Added " + usd(r.deltaMicro, 2) + " to " + agent.name + ". Balance " + usd(r.balanceAfterMicro, 2) + ".");
}

function simple(agent, verb, doing, done, button) {
  return act(button, doing + " " + agent.name + "…", () => api("POST", "/api/agents/" + agent.address + "/" + verb, {}),
    (r) => verb === "start" && r.runtime !== "running"
      ? "Started the container for " + agent.name + ", but the agent process is not running. Open details to read its log."
      : done + " " + agent.name + ".");
}

function removeAgent(agent, button) {
  return act(button, "Removing " + agent.name + "…", async () => {
    const r = await api("POST", "/api/agents/" + agent.address + "/remove", {});
    delete state.confirming[agent.address];
    delete state.open[agent.address];
    return r;
  }, (r) => "Removed " + agent.name + ". Deleted " + r.removed.length + " container(s) and revoked " + r.revokedKeys + " key(s).");
}

function removeSandbox(sandbox, button) {
  return act(button, "Removing container " + sandbox.name + "…", async () => {
    const r = await api("POST", "/api/sandboxes/" + sandbox.id + "/remove", {});
    delete state.confirming[sandbox.id];
    return r;
  }, "Removed container " + sandbox.name + ".");
}

function sendMessage(agent, button) {
  const text = (state.drafts[agent.address] || "").trim();
  if (!text) { say("Write a message before sending.", true); return; }
  return act(button, "Sending message to " + agent.name + "…", async () => {
    const r = await api("POST", "/api/agents/" + agent.address + "/message", { content: text });
    delete state.drafts[agent.address];
    return r;
  }, "Sent message to " + agent.name + ".");
}

/**
 * Copy text to the clipboard. navigator.clipboard exists only on secure
 * origins (HTTPS or loopback); a phone on the home network reaches this page
 * over plain HTTP, so fall back to copying from a temporary selected field.
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.className = "visually-hidden";
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  field.remove();
  return ok;
}

async function copyAddress(agent, button) {
  if (await copyText(agent.address)) say("Copied " + agent.name + "'s address.");
  else say(agent.name + "'s address: " + agent.address);
  button.focus();
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}
function isAppleTouch() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Explain how to install on this device, in terms of what it is. */
function renderDeviceHelp() {
  const hint = $("install-hint");
  if (isStandalone()) {
    hint.textContent = "Installed as an app on this device.";
  } else if (isAppleTouch()) {
    hint.textContent = "To install: tap Share, then Add to Home Screen. The app asks for the admin token once. Copy it here first, then paste it in the app.";
  } else {
    hint.textContent = "To use this on your phone, run automaton-host phone on this machine and scan the code it prints. The phone app asks for the admin token once.";
  }
}

async function copyToken(button) {
  if (!state.token) return;
  if (await copyText(state.token)) say("Copied the admin token. Anyone who has it can fund and stop agents.");
  else say("Could not copy on this browser. Run automaton-host dashboard on the host machine to see the token.", true);
  button.focus();
}

function toggleDetails(agent) {
  if (state.open[agent.address]) { delete state.open[agent.address]; render(); }
  else openTab(agent, "log");
}

function openTab(agent, tab) {
  state.open[agent.address] = tab;
  render();
  if (tab === "log") loadLog(agent);
  if (tab === "ledger") loadAgentLedger(agent);
}

async function loadLog(agent, button) {
  if (button) button.disabled = true;
  try {
    const r = await api("GET", "/api/logs?lines=150&agent=" + encodeURIComponent(agent.address));
    state.logs[agent.address] = r.text;
    if (button) say("Reloaded the log for " + agent.name + ".");
  } catch (err) {
    if (err.unauthorized) return showConnect(err.message);
    state.logs[agent.address] = "Could not read the log: " + err.message;
  }
  render();
  const pre = document.querySelector('.agent[data-address="' + agent.address + '"] .log');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

async function loadAgentLedger(agent) {
  try {
    const r = await api("GET", "/api/ledger?limit=40&agent=" + encodeURIComponent(agent.address));
    state.ledgers[agent.address] = r.entries;
  } catch (err) {
    if (err.unauthorized) return showConnect(err.message);
    state.ledgers[agent.address] = [];
    say(err.message, true);
  }
  render();
}

// ─── Launch dialog ─────────────────────────────────────────────

function openLaunch() {
  $("launch-error").hidden = true;
  $("launch-dialog").showModal();
  $("launch-name").focus();
}

async function submitLaunch(e) {
  e.preventDefault();
  const form = $("launch-form");
  if (!form.reportValidity()) return;
  const button = $("launch-submit");
  const errorBox = $("launch-error");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "Launching…";
  try {
    const name = $("launch-name").value.trim();
    const r = await api("POST", "/api/launch", {
      name,
      genesisPrompt: $("launch-genesis").value,
      fundUsd: $("launch-fund").value === "" || Number($("launch-fund").value) === 0 ? undefined : Number($("launch-fund").value),
      memoryMb: Number($("launch-memory").value),
    });
    $("launch-dialog").close();
    form.reset();
    await refresh();
    say(r.runtime === "running"
      ? "Launched " + r.name + " with " + r.balanceUsd + "."
      : "Created " + r.name + ", but its agent process is not running. Open details to read its log.", r.runtime !== "running");
  } catch (err) {
    if (err.unauthorized) { $("launch-dialog").close(); return showConnect(err.message); }
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Launch agent";
  }
}

// ─── Connection ────────────────────────────────────────────────

function showConnect(message) {
  stopTimer();
  state.overview = null;
  $("app").hidden = true;
  $("connect").hidden = false;
  $("sign-out").hidden = true;
  document.body.classList.add("is-signed-out");
  say(message || "", !!message);
  $("token-input").focus();
}

async function connect(token) {
  state.token = token;
  try {
    await refresh();
    storeToken(token);
    document.body.classList.remove("is-signed-out");
    $("sign-out").hidden = false;
    say("");
    startTimer();
  } catch (err) {
    state.token = null;
    if (err.unauthorized) { storeToken(null); showConnect("That token was not accepted. Copy it again from automaton-host dashboard."); }
    else showConnect("Could not reach the host: " + err.message);
  }
}

function signOut() {
  storeToken(null);
  state.token = null;
  $("token-input").value = "";
  showConnect("Signed out on this device. The token itself is unchanged.");
}

function startTimer() {
  stopTimer();
  if (!$("auto-refresh").checked) return;
  state.timer = setInterval(() => {
    // Do not redraw under an open dialog or while a removal awaits confirmation.
    if (document.hidden || $("launch-dialog").open) return;
    refresh().catch((err) => { if (err.unauthorized) showConnect(err.message); else say(err.message, true); });
  }, 10000);
}
function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function init() {
  $("refresh").addEventListener("click", (e) => manualRefresh(e.currentTarget));
  $("auto-refresh").addEventListener("change", (e) => {
    startTimer();
    say(e.target.checked ? "Refreshing every 10 seconds." : "Automatic refresh is off.");
  });
  $("open-launch").addEventListener("click", openLaunch);
  $("launch-cancel").addEventListener("click", () => $("launch-dialog").close());
  $("launch-form").addEventListener("submit", submitLaunch);
  $("open-job").addEventListener("click", openJob);
  $("job-cancel").addEventListener("click", () => $("job-dialog").close());
  $("job-form").addEventListener("submit", submitJob);
  $("check-payments").addEventListener("click", (e) => checkPayments(e.currentTarget));
  $("email-pause-all").addEventListener("click", (e) => pauseEmail("all", "every agent", !(state.email && state.email.paused), e.currentTarget));
  $("email-block").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("email-block-key");
    const key = input.value.trim();
    if (!key) return;
    await blockEmail(key, e.submitter || e.currentTarget.querySelector("button"));
    input.value = "";
  });
  $("ledger-filter").addEventListener("change", () => refresh().catch((err) => say(err.message, true)));
  $("sign-out").addEventListener("click", signOut);
  $("copy-token").addEventListener("click", (e) => copyToken(e.currentTarget));
  renderDeviceHelp();
  if (isStandalone()) {
    $("connect-help").textContent = "Paste your admin token. To get it, open the dashboard in Safari and tap Copy admin token.";
  }
  $("connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("token-input").value.trim();
    if (t) connect(t);
  });

  // Opening the link while this page is already open changes only the
  // fragment, which does not reload the page; pick the token up then too.
  window.addEventListener("hashchange", () => {
    const t = takeTokenFromUrl();
    if (t) connect(t);
  });

  const token = takeTokenFromUrl() || readStoredToken();
  if (token) connect(token); else showConnect("");
}

/**
 * The token arrives in the URL fragment (never sent to any server). Take it,
 * then clear the address bar so it is not left in history or a share.
 */
function takeTokenFromUrl() {
  const m = /[#&]token=([0-9a-fA-F]+)/.exec(window.location.hash);
  if (!m) return null;
  window.history.replaceState(null, "", window.location.pathname);
  return m[1];
}

init();
