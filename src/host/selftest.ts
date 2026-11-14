/**
 * Host Control Plane — selftest
 *
 * Checks the real outside services this host depends on, with your real
 * credentials, from your own machine:
 *
 *   model     one short real call to each configured model
 *   stripe    TEST MODE ONLY: sign-in, a checkout link, a subscription
 *             checkout link, and a real test card payment that is then
 *             refunded. A live key (sk_live_/rk_live_) is refused.
 *   tunnel    the public address reaches THIS storefront (a one-time code
 *             written here must come back through the internet), and the
 *             agent API and dashboard are not reachable through it
 *   printful  the token works and every configured variant exists.
 *             No order is placed: that would cost real money.
 *
 * Nothing here changes agents, the ledger, or stores.
 */

import type { MailTransport } from "./mail.js";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { HostConfig, HostModelConfig } from "./config.js";
import { formEncode, type FetchLike } from "./economy.js";
import { costMicro, type UpstreamChat } from "./inference-proxy.js";
import { PrintfulClient } from "./printful.js";
import { formatUsd } from "./store.js";

export type CheckName = "model" | "stripe" | "tunnel" | "printful" | "research" | "email" | "sites";
export const ALL_CHECKS: CheckName[] = ["model", "stripe", "tunnel", "printful", "research", "email", "sites"];

export interface CheckResult {
  check: CheckName;
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export interface SelftestOptions {
  config: HostConfig;
  hostDir: string;
  only?: CheckName[];
  stripeKey?: string;
  printfulToken?: string;
  chat?: UpstreamChat;
  fetchImpl?: FetchLike;
  /** Wait for the tunnel answer; Cloudflare can take a few seconds to route a new tunnel. */
  tunnelTimeoutMs?: number;
  /** The creator's mailbox; absent when EMAIL_PASSWORD is not set. */
  mail?: MailTransport;
  /** How long to wait for the test email to arrive back. */
  mailTimeoutMs?: number;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function runSelftest(opts: SelftestOptions): Promise<CheckResult[]> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as any);
  const want = new Set(opts.only?.length ? opts.only : ALL_CHECKS);
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);
  const skip = (check: CheckName, name: string, detail: string) => add({ check, name, ok: true, skipped: true, detail });

  // ─── Model ───────────────────────────────────────────────────
  if (want.has("model")) {
    if (!opts.chat) skip("model", "model calls", "no model client");
    else {
      const seen = new Set<string>();
      for (const m of opts.config.models) {
        if (seen.has(`${m.upstream}:${m.id}`)) continue;
        seen.add(`${m.upstream}:${m.id}`);
        const started = Date.now();
        try {
          // Local models are free, and thinking ones (Qwen 3.x, Gemma 4) reason
          // for ~100+ tokens before the reply; 16 would cut them off with empty
          // content. Paid models stay at 16 so the check costs next to nothing.
          const maxTokens = m.upstream === "ollama" ? 1024 : 16;
          const r = await opts.chat(m as HostModelConfig, [{ role: "user", content: "Reply with the single word: ready" }], { maxTokens });
          const text = typeof r.message?.content === "string" ? r.message.content.trim() : "";
          const cost = costMicro(m as HostModelConfig, r.usage?.promptTokens ?? 0, r.usage?.completionTokens ?? 0);
          add({
            check: "model",
            name: `${m.upstream} ${m.id}`,
            ok: text.length > 0,
            detail: text
              ? `answered "${text.slice(0, 40)}" in ${Date.now() - started} ms; ${r.usage?.promptTokens ?? "?"} in / ${r.usage?.completionTokens ?? "?"} out tokens, ${formatUsd(cost)} at your configured prices`
              : "answered with no text",
          });
        } catch (err) {
          add({ check: "model", name: `${m.upstream} ${m.id}`, ok: false, detail: errText(err) });
        }
      }
    }
  }

  // ─── Stripe (test mode only) ─────────────────────────────────
  if (want.has("stripe")) {
    const key = opts.stripeKey;
    if (!key) add({ check: "stripe", name: "Stripe key", ok: false, detail: "STRIPE_SECRET_KEY is not set in this shell" });
    else if (/^(sk|rk)_live_/.test(key)) {
      add({ check: "stripe", name: "Stripe key", ok: false, detail: "this is a LIVE key. selftest only runs in test mode: run it with your sk_test_ key, then start serve with the live key" });
    } else {
      const base = opts.config.stripe.apiBase;
      const stripe = async (method: "GET" | "POST", p: string, fields?: Record<string, string | number>) => {
        const res = await doFetch(new URL(p, base).toString(), {
          method,
          headers: { Authorization: `Bearer ${key}`, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
          body: fields ? formEncode(fields) : undefined,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Stripe ${res.status}: ${body?.error?.message || "no detail"}`);
        return body;
      };
      const cur = opts.config.stripe.currency;
      const back = opts.config.storefront.publicUrl || "https://example.com";
      try {
        const bal = await stripe("GET", "/v1/balance");
        if (bal?.livemode === true) throw new Error("Stripe says this key is in live mode; use a test key");
        add({ check: "stripe", name: "sign in (test mode)", ok: true, detail: "key accepted" });

        const line = {
          "line_items[0][quantity]": 1,
          "line_items[0][price_data][currency]": cur,
          "line_items[0][price_data][unit_amount]": 500,
          "line_items[0][price_data][product_data][name]": "automaton selftest",
        };
        const pay = await stripe("POST", "/v1/checkout/sessions", { mode: "payment", success_url: `${back}/`, cancel_url: `${back}/`, ...line });
        await stripe("POST", `/v1/checkout/sessions/${encodeURIComponent(pay.id)}/expire`, {});
        add({ check: "stripe", name: "checkout link", ok: /^https:\/\//.test(pay.url), detail: `created and expired ${pay.id}` });

        const sub = await stripe("POST", "/v1/checkout/sessions", { mode: "subscription", success_url: `${back}/`, cancel_url: `${back}/`, ...line, "line_items[0][price_data][recurring][interval]": "month" });
        await stripe("POST", `/v1/checkout/sessions/${encodeURIComponent(sub.id)}/expire`, {});
        add({ check: "stripe", name: "subscription checkout link", ok: /^https:\/\//.test(sub.url), detail: `created and expired ${sub.id}` });

        if (opts.config.printful.products.length) {
          const ship: Record<string, string> = {};
          opts.config.printful.shipCountries.forEach((c, i) => (ship[`shipping_address_collection[allowed_countries][${i}]`] = c));
          const s = await stripe("POST", "/v1/checkout/sessions", { mode: "payment", success_url: `${back}/`, cancel_url: `${back}/`, ...line, ...ship });
          await stripe("POST", `/v1/checkout/sessions/${encodeURIComponent(s.id)}/expire`, {});
          add({ check: "stripe", name: "checkout with shipping address", ok: true, detail: `countries ${opts.config.printful.shipCountries.join(", ")}` });
        }

        // A real test-card payment and its refund: the same money path a buyer's payment takes.
        const pi = await stripe("POST", "/v1/payment_intents", {
          amount: 500,
          currency: cur,
          payment_method: "pm_card_visa",
          confirm: "true",
          "automatic_payment_methods[enabled]": "true",
          "automatic_payment_methods[allow_redirects]": "never",
          description: "automaton selftest",
        });
        if (pi?.status !== "succeeded") throw new Error(`test payment ended as ${pi?.status}`);
        const ref = await stripe("POST", "/v1/refunds", { payment_intent: pi.id });
        add({ check: "stripe", name: "test payment and refund", ok: ["succeeded", "pending"].includes(ref?.status), detail: `${pi.id} paid, refund ${ref?.status}` });
      } catch (err) {
        add({ check: "stripe", name: "Stripe", ok: false, detail: errText(err) });
      }
    }
  }

  // ─── Tunnel ──────────────────────────────────────────────────
  if (want.has("tunnel")) {
    const pub = opts.config.storefront.publicUrl.replace(/\/$/, "");
    if (!pub) add({ check: "tunnel", name: "public address", ok: false, detail: "storefront.publicUrl is not set in host.json" });
    else {
      const noncePath = path.join(opts.hostDir, "selftest-nonce");
      const nonce = randomBytes(18).toString("base64url");
      fs.writeFileSync(noncePath, nonce, { mode: 0o600 });
      try {
        const deadline = Date.now() + (opts.tunnelTimeoutMs ?? 15_000);
        let got = "";
        let lastErr = "";
        while (Date.now() < deadline) {
          try {
            const r = await doFetch(`${pub}/.well-known/automaton-selftest`, { method: "GET" });
            got = (await r.text?.()) ?? "";
            if (got.trim() === nonce) break;
            lastErr = `answered "${got.trim().slice(0, 40)}" (${r.status})`;
          } catch (err) {
            lastErr = errText(err);
          }
          await new Promise((res) => setTimeout(res, 1000));
        }
        const reached = got.trim() === nonce;
        add({
          check: "tunnel",
          name: "public address reaches this storefront",
          ok: reached,
          detail: reached ? `${pub} answers with the code written on this machine` : `${pub}: ${lastErr || "no answer"}. Is serve running, and the tunnel pointed at 127.0.0.1:${opts.config.storefront.port}?`,
        });
        if (reached) {
          const leaks: string[] = [];
          for (const p of ["/api/overview", "/v1/store", "/v1/auth/nonce", "/manifest.webmanifest"]) {
            try {
              const r = await doFetch(`${pub}${p}`, { method: "GET" });
              const body = (await r.text?.()) ?? "";
              if (r.status === 200 || /"error"\s*:|"nonce"\s*:|"agents"\s*:/.test(body)) leaks.push(`${p} (${r.status})`);
            } catch {
              // unreachable is fine
            }
          }
          add({
            check: "tunnel",
            name: "agent API and dashboard stay private",
            ok: leaks.length === 0,
            detail: leaks.length ? `reachable through the public address: ${leaks.join(", ")}. Point the tunnel only at port ${opts.config.storefront.port}` : "not reachable through the public address",
          });
          const home = await doFetch(`${pub}/`, { method: "GET" });
          const csp = home.headers?.get("content-security-policy") || "";
          add({ check: "tunnel", name: "store home page", ok: home.status === 200 && csp.includes("default-src 'none'"), detail: `status ${home.status}${csp ? ", locked-down page policy present" : ", page policy missing"}` });
        }
      } finally {
        fs.rmSync(noncePath, { force: true });
      }
    }
  }

  // ─── Printful ────────────────────────────────────────────────
  if (want.has("printful")) {
    if (!opts.printfulToken) skip("printful", "Printful", "PRINTFUL_API_TOKEN is not set; print-on-demand stays off");
    else {
      const pf = new PrintfulClient(opts.config.printful, opts.printfulToken, opts.fetchImpl);
      try {
        add({ check: "printful", name: "token", ok: true, detail: await pf.verifyToken() });
        if (!opts.config.printful.products.length) skip("printful", "products", "printful.products is empty in host.json; agents have nothing to design for");
        for (const p of opts.config.printful.products) {
          for (const v of p.variants) {
            try {
              const name = await pf.variant(v.id);
              add({ check: "printful", name: `${p.key} ${v.label}`, ok: true, detail: name });
            } catch (err) {
              add({ check: "printful", name: `${p.key} ${v.label}`, ok: false, detail: `variant ${v.id}: ${errText(err)}` });
            }
          }
        }
        if (!opts.config.printful.autoConfirm) skip("printful", "orders", "autoConfirm is off: orders wait in Printful as drafts until you confirm them");
      } catch (err) {
        add({ check: "printful", name: "token", ok: false, detail: errText(err) });
      }
    }
  }

  // ─── Research sources ────────────────────────────────────────
  if (want.has("research")) {
    const rs = opts.config.research;
    if (!rs.enabled) skip("research", "market research", "research.enabled is false");
    else {
      const ua = { "User-Agent": "automaton-host/1.0 (selftest)", Accept: "application/json" };
      try {
        const r = await doFetch(`${rs.hackernewsBase.replace(/\/$/, "")}/api/v1/search?tags=front_page&hitsPerPage=3`, { method: "GET", headers: ua });
        const body = await r.json();
        add({ check: "research", name: "Hacker News", ok: r.ok && Array.isArray(body?.hits), detail: r.ok ? `${body?.hits?.length ?? 0} front-page stories` : `HTTP ${r.status}` });
      } catch (err) {
        add({ check: "research", name: "Hacker News", ok: false, detail: errText(err) });
      }
      try {
        const d = new Date(Date.now() - 2 * 86_400_000);
        const r = await doFetch(`${rs.wikimediaBase.replace(/\/$/, "")}/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`, { method: "GET", headers: ua });
        const body = await r.json();
        const n = body?.items?.[0]?.articles?.length ?? 0;
        add({ check: "research", name: "Wikipedia pageviews", ok: r.ok && n > 0, detail: r.ok ? `${n} top articles` : `HTTP ${r.status}` });
      } catch (err) {
        add({ check: "research", name: "Wikipedia pageviews", ok: false, detail: errText(err) });
      }
      // The business finder: one place lookup and one tiny map query.
      try {
        const r = await doFetch(`${rs.nominatimBase.replace(/\/$/, "")}/search?q=${encodeURIComponent("Hamilton, Ontario")}&format=jsonv2&limit=1`, { method: "GET", headers: ua });
        const body = await r.json();
        add({ check: "research", name: "OpenStreetMap places", ok: r.ok && Array.isArray(body) && body.length > 0, detail: r.ok ? `found ${String(body?.[0]?.display_name ?? "nothing").slice(0, 60)}` : `HTTP ${r.status}` });
      } catch (err) {
        add({ check: "research", name: "OpenStreetMap places", ok: false, detail: errText(err) });
      }
      try {
        const r = await doFetch(rs.overpassBase, { method: "POST", headers: { ...ua, "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent("[out:json][timeout:10];node(1);out ids;")}` });
        const body = await r.json();
        add({ check: "research", name: "OpenStreetMap businesses", ok: r.ok && Array.isArray(body?.elements), detail: r.ok ? "the map query server answers" : `HTTP ${r.status}` });
      } catch (err) {
        add({ check: "research", name: "OpenStreetMap businesses", ok: false, detail: errText(err) });
      }
    }
  }

  // ─── Email ───────────────────────────────────────────────────
  if (want.has("email")) {
    const em = opts.config.email;
    const missing = [
      !em.fromAddress && "email.fromAddress",
      !em.smtpHost && "email.smtpHost",
      !em.imapHost && "email.imapHost",
      em.mailingAddress.trim().length < 10 && "email.mailingAddress (your postal address; the law requires it in every email)",
      !opts.config.storefront.operatorName.trim() && "storefront.operatorName",
      !opts.config.storefront.publicUrl && "storefront.publicUrl (the unsubscribe link lives there)",
      !opts.mail && "EMAIL_PASSWORD in this shell",
    ].filter(Boolean);
    // Email is optional: not started at all is a skip, half set up is a failure.
    if (!em.fromAddress && !em.smtpHost && !opts.mail) skip("email", "agent email", "not set up (email.fromAddress, email.smtpHost, EMAIL_PASSWORD)");
    else if (missing.length) add({ check: "email", name: "settings", ok: false, detail: `missing: ${missing.join(", ")}` });
    if (opts.mail) {
      let ok = false;
      try {
        add({ check: "email", name: "mailbox login", ok: true, detail: await opts.mail.verify() });
        ok = true;
      } catch (err) {
        add({ check: "email", name: "mailbox login", ok: false, detail: errText(err) });
      }
      if (ok) {
        // Send one email to the mailbox itself and wait to read it back over IMAP.
        try {
          const before = await opts.mail.fetchNew(0, null);
          const tag = `automaton selftest ${randomBytes(6).toString("hex")}`;
          await opts.mail.send({ from: em.fromAddress, to: em.fromAddress, subject: tag, text: "Sent by `automaton-host selftest` to check sending and receiving. Safe to delete.", messageId: `<selftest.${randomBytes(6).toString("hex")}@${em.fromAddress.split("@")[1]}>`, headers: {} });
          const deadline = Date.now() + (opts.mailTimeoutMs ?? 90_000);
          let found = false;
          let after = before.lastUid;
          while (!found && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 3000));
            const r = await opts.mail.fetchNew(after, before.uidValidity);
            after = r.lastUid;
            found = r.messages.some((m) => m.subject === tag);
          }
          add({
            check: "email",
            name: "send and receive",
            ok: found,
            detail: found ? "a test email sent over SMTP arrived in the inbox over IMAP" : "the test email did not arrive within the wait; check the spam folder and the SMTP settings",
          });
        } catch (err) {
          add({ check: "email", name: "send and receive", ok: false, detail: errText(err) });
        }
      }
    }
  }

  // ─── Client sites ────────────────────────────────────────────
  if (want.has("sites")) {
    const base = opts.config.sites.publicUrl.replace(/\/$/, "");
    if (!base) skip("sites", "client sites", "sites.publicUrl is not set");
    else {
      try {
        const r = await doFetch(`${base}/selftest-${randomBytes(4).toString("hex")}/`, { method: "GET" });
        const text = (await r.text?.()) ?? "";
        const ours = r.status === 404 && text.includes("This site is not active");
        add({ check: "sites", name: "public address", ok: ours, detail: ours ? `${base} reaches the client-site server` : `got HTTP ${r.status}; point a tunnel hostname at 127.0.0.1:${opts.config.sites.port}` });
      } catch (err) {
        add({ check: "sites", name: "public address", ok: false, detail: errText(err) });
      }
    }
  }

  // ─── Settings a buyer sees ───────────────────────────────────
  if (want.has("tunnel") || want.has("stripe")) {
    const sf = opts.config.storefront;
    const missing = [!sf.operatorName.trim() && "operatorName", !sf.contactEmail.trim() && "contactEmail"].filter(Boolean);
    if (missing.length) add({ check: "tunnel", name: "store owner details", ok: false, detail: `set storefront.${missing.join(" and storefront.")} in host.json; nothing can be bought without them` });
  }
  return results;
}

export function formatSelftest(results: CheckResult[]): string {
  const lines = results.map((r) => `${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(8)} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  lines.push("", failed ? `${failed} check(s) failed.` : "All checks passed.");
  return lines.join("\n");
}
