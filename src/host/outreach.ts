/**
 * Host Control Plane — Email outreach
 *
 * Agents email businesses they find, and carry on the conversation when
 * someone replies. They send on their own, but every message passes through
 * rules here that the agent cannot change. The rules follow what Canada's
 * anti-spam law (CASL) and the US CAN-SPAM Act require of commercial email
 * sent without prior consent, as far as software can check them. Running
 * cold outreach at all is the creator's legal decision; these rules don't
 * make it legal everywhere.
 *
 *   - Business addresses only. A first email needs the public page where the
 *     address is listed. The host fetches that page and refuses if the
 *     address is not on it, or the page says it does not want unsolicited
 *     email. Free mailbox domains (gmail.com and similar) are refused for
 *     first contact.
 *   - Every email names its sender truthfully: the agent, that it is an AI
 *     agent, and who runs it. It carries the creator's mailing address, a
 *     one-click unsubscribe link and List-Unsubscribe headers. Replying
 *     "unsubscribe" works too.
 *   - Unsubscribes, bounces and the creator's own block list apply to every
 *     agent at once, at once. An unsubscribe can cover the whole business
 *     domain.
 *   - A business is contacted by one agent at a time: no second first email
 *     to the same address within `recontactDays`. At most `maxFollowUps`
 *     follow-ups, `followUpDays` apart, and none after a reply.
 *   - Daily caps per agent and for the whole host.
 *
 * Replies are read from the creator's mailbox over IMAP, matched to their
 * conversation, and shown to the agent as untrusted text.
 */

import { createHash, randomBytes } from "crypto";
import dns from "dns/promises";
import net from "net";
import { monotonicFactory } from "ulid";
import type { HostConfig } from "./config.js";
import type { FetchLike } from "./economy.js";
import type { IncomingMail, MailTransport } from "./mail.js";
import { HOST_NOTICE_SENDER, normalizeAddress, type HostStore } from "./store.js";

const ulid = monotonicFactory();

export class OutreachError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_request") {
    super(message);
    this.name = "OutreachError";
  }
}

export interface EmailConfig {
  /** The mailbox agents send from and replies arrive at. */
  fromAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  /** Your postal address. Required in every commercial email by CASL and CAN-SPAM. */
  mailingAddress: string;
  perAgentPerDay: number;
  hostPerDay: number;
  followUpDays: number;
  maxFollowUps: number;
  /** No new first email to an address another agent emailed within this many days. */
  recontactDays: number;
  pollSeconds: number;
  /** Unsubscribing from one address stops email to everyone at that domain. */
  suppressDomainOnUnsubscribe: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_contacts (
  address        TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,
  business_name  TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  relevance      TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_suppression (
  key        TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_threads (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  contact       TEXT NOT NULL,
  subject       TEXT NOT NULL,
  status        TEXT NOT NULL,
  followups     INTEGER NOT NULL DEFAULT 0,
  unsub_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_out_at   TEXT,
  last_in_at    TEXT,
  agent_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS email_threads_contact ON email_threads(contact, created_at);
CREATE INDEX IF NOT EXISTS email_threads_agent ON email_threads(address, status);
CREATE TABLE IF NOT EXISTS email_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  address     TEXT NOT NULL,
  direction   TEXT NOT NULL,
  message_id  TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  automatic   INTEGER NOT NULL DEFAULT 0,
  attachments TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_messages_mid ON email_messages(message_id);
CREATE INDEX IF NOT EXISTS email_messages_out ON email_messages(direction, at);
CREATE TABLE IF NOT EXISTS email_state (
  k  TEXT PRIMARY KEY,
  v  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_paused (
  address  TEXT PRIMARY KEY,
  at       TEXT NOT NULL
);
`;

/** Personal mailbox providers. A first email to these is refused: they are rarely a business's published address. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.ca", "ymail.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com",
  "yandex.com", "yandex.ru", "qq.com", "163.com", "hey.com", "fastmail.com", "tutanota.com", "rogers.com", "shaw.ca", "sympatico.ca",
]);

/** A page that says, near its address, that it does not want unsolicited email. */
const NO_SOLICITATION =
  /\b(no|not accept|do not want|don['’]t want|does not accept|do not send|don['’]t send)\b[^.<>]{0,40}\b(unsolicited|commercial|marketing|sales|solicitation|solicitations|spam)\b|\bno solicit/i;

const UNSUBSCRIBE_WORDS = /\b(unsubscribe|remove me|take me off|stop (emailing|sending|contacting)|do not (contact|email)|don['’]t (contact|email)|opt[- ]?out)\b/i;

/** Stored in email_paused to stop every agent's email at once. */
export const PAUSE_ALL = "0x0000000000000000000000000000000000000000";

/** Sender of the host's "you have a reply" notes: the host's general notice sender. */
export const MAIL_NOTICE_SENDER = HOST_NOTICE_SENDER;

export const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();

function clean(v: unknown, max: number, what: string, keepNewlines = false): string {
  let s = typeof v === "string" ? v : "";
  s = keepNewlines
    ? s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{4,}/g, "\n\n\n")
    : s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ");
  s = s.trim();
  if (!s || s.length > max) throw new OutreachError(`${what} must be 1 to ${max} characters`);
  return s;
}

/** True for addresses on the public internet; false for loopback, private, link-local and similar. */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return false;
  if (v.startsWith("::ffff:")) return isPublicIp(v.slice(7));
  return true;
}

export interface Thread {
  id: string;
  address: string;
  contact: string;
  subject: string;
  status: "open" | "replied" | "unsubscribed" | "bounced" | "closed";
  followups: number;
  createdAt: string;
  lastOutAt: string | null;
  lastInAt: string | null;
}

export interface Message {
  id: string;
  direction: "out" | "in";
  subject: string;
  body: string;
  automatic: boolean;
  at: string;
}

const mapThread = (r: any): Thread => ({
  id: r.id, address: r.address, contact: r.contact, subject: r.subject, status: r.status, followups: r.followups,
  createdAt: r.created_at, lastOutAt: r.last_out_at, lastInAt: r.last_in_at,
});

export interface OutreachOptions {
  transport?: MailTransport;
  /** Fetches a business's page to confirm its address is published there. */
  pageFetch?: FetchLike;
  /** Hostname check before fetching; tests replace it. */
  resolveHost?: (host: string) => Promise<string[]>;
  log?: (m: string) => void;
}

export class Outreach {
  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    private readonly opts: OutreachOptions = {},
  ) {
    this.store.db.exec(SCHEMA);
  }

  private get cfg(): EmailConfig {
    return this.config.email;
  }

  /** Everything email needs before an agent may send. */
  get missing(): string[] {
    const m: string[] = [];
    if (!this.opts.transport) m.push("EMAIL_PASSWORD (and email.smtpHost / email.imapHost)");
    if (!EMAIL_RE.test(this.cfg.fromAddress.toLowerCase())) m.push("email.fromAddress");
    if (this.cfg.mailingAddress.trim().length < 10) m.push("email.mailingAddress");
    if (!this.config.storefront.operatorName.trim()) m.push("storefront.operatorName");
    // The unsubscribe link lives on the public storefront.
    if (!this.config.storefront.publicUrl) m.push("storefront.publicUrl");
    return m;
  }

  get enabled(): boolean {
    return this.missing.length === 0;
  }

  // ─── Suppression and pausing ─────────────────────────────────

  isSuppressed(email: string): string | null {
    const e = email.toLowerCase();
    const domain = e.split("@")[1] ?? "";
    const r = this.store.db.prepare("SELECT reason FROM email_suppression WHERE key IN (?, ?)").get(e, `@${domain}`) as { reason: string } | undefined;
    return r?.reason ?? null;
  }

  suppress(key: string, reason: string): void {
    const k = key.trim().toLowerCase();
    if (!(EMAIL_RE.test(k) || /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(k))) throw new OutreachError("Give an email address or @domain");
    this.store.db.prepare("INSERT OR REPLACE INTO email_suppression (key, reason, at) VALUES (?, ?, ?)").run(k, reason.slice(0, 100), nowIso());
    const matching = k.startsWith("@")
      ? this.store.db.prepare("SELECT id FROM email_threads WHERE contact LIKE ? AND status IN ('open','replied')").all(`%${k}`)
      : this.store.db.prepare("SELECT id FROM email_threads WHERE contact = ? AND status IN ('open','replied')").all(k);
    const status = reason === "bounced" ? "bounced" : reason.startsWith("unsubscribed") ? "unsubscribed" : "closed";
    for (const t of matching as Array<{ id: string }>) this.store.db.prepare("UPDATE email_threads SET status = ? WHERE id = ?").run(status, t.id);
  }

  /** Lifts a block or a bounce. An unsubscribe is the recipient's decision and cannot be lifted here. */
  unsuppress(key: string): boolean {
    const k = key.trim().toLowerCase();
    const r = this.store.db.prepare("SELECT reason FROM email_suppression WHERE key = ?").get(k) as { reason: string } | undefined;
    if (r?.reason.startsWith("unsubscribed")) throw new OutreachError(`${k} unsubscribed. Only they can opt back in, by writing to you.`, 409, "unsubscribed");
    return this.store.db.prepare("DELETE FROM email_suppression WHERE key = ?").run(k).changes === 1;
  }

  listSuppressed(): Array<{ key: string; reason: string; at: string }> {
    return this.store.db.prepare("SELECT * FROM email_suppression ORDER BY at DESC LIMIT 500").all() as any;
  }

  setPaused(addressRaw: string, paused: boolean): void {
    const a = normalizeAddress(addressRaw);
    if (paused) this.store.db.prepare("INSERT OR REPLACE INTO email_paused (address, at) VALUES (?, ?)").run(a, nowIso());
    else this.store.db.prepare("DELETE FROM email_paused WHERE address = ?").run(a);
  }

  isPaused(addressRaw: string): boolean {
    const a = normalizeAddress(addressRaw);
    return Boolean(this.store.db.prepare("SELECT 1 FROM email_paused WHERE address IN (?, ?)").get(a, PAUSE_ALL));
  }

  // ─── Limits ──────────────────────────────────────────────────

  sentToday(addressRaw?: string, now = Date.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    const r = addressRaw
      ? this.store.db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'out' AND address = ? AND substr(at,1,10) = ?").get(normalizeAddress(addressRaw), day)
      : this.store.db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'out' AND substr(at,1,10) = ?").get(day);
    return (r as { n: number }).n;
  }

  private assertCanSend(address: string, now: number): void {
    if (!this.enabled) throw new OutreachError(`Email is not set up on this host (missing: ${this.missing.join(", ")})`, 503, "email_disabled");
    if (this.store.isDead(address)) throw new OutreachError("This account is dead", 403, "account_dead");
    if (this.store.isFrozen(address)) throw new OutreachError("Account is frozen by the creator", 403, "account_frozen");
    if (this.isPaused(address)) throw new OutreachError("Your creator has paused your email", 403, "email_paused");
    if (this.sentToday(address, now) >= this.cfg.perAgentPerDay) throw new OutreachError(`You have sent your ${this.cfg.perAgentPerDay} emails for today (UTC)`, 429, "email_daily_limit");
    if (this.sentToday(undefined, now) >= this.cfg.hostPerDay) throw new OutreachError("This host has sent its emails for today (UTC); try tomorrow", 429, "email_host_limit");
  }

  // ─── Checking the published address ──────────────────────────

  private async confirmPublished(email: string, sourceUrl: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(sourceUrl);
    } catch {
      throw new OutreachError("source_url is not a web address");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new OutreachError("source_url must be a web page (http or https)");
    if (u.username || u.password) throw new OutreachError("source_url must not contain credentials");
    // The host fetches a page an agent chose: never one on this machine or a private network.
    const resolve = this.opts.resolveHost ?? (async (h: string) => (await dns.lookup(h, { all: true })).map((r) => r.address));
    let ips: string[];
    try {
      ips = net.isIP(u.hostname) ? [u.hostname] : await resolve(u.hostname);
    } catch {
      throw new OutreachError(`Could not find ${u.hostname}`);
    }
    if (!ips.length || !ips.every(isPublicIp)) throw new OutreachError("source_url must be a page on the public internet");
    const doFetch: FetchLike = this.opts.pageFetch ?? ((url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) } as any) as any);
    let html = "";
    try {
      const res = await doFetch(u.toString(), { method: "GET", headers: { "User-Agent": "automaton-host/1.0 (address check)", Accept: "text/html,*/*" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = ((await res.text?.()) ?? "").slice(0, 3_000_000);
    } catch (err) {
      throw new OutreachError(`Could not read ${u.hostname} to confirm the address is listed there (${err instanceof Error ? err.message : String(err)})`);
    }
    const page = html
      .replace(/&#64;|&#x40;|&commat;/gi, "@")
      .replace(/&#46;|&#x2e;|&period;/gi, ".")
      .toLowerCase();
    if (!page.includes(email)) throw new OutreachError(`${email} does not appear on ${u.toString()}. First emails go only to addresses a business publishes itself.`, 422, "address_not_published");
    const text = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (NO_SOLICITATION.test(text)) throw new OutreachError(`${u.hostname} says it does not want unsolicited email. Do not contact it.`, 422, "no_solicitation");
  }

  // ─── Sending ─────────────────────────────────────────────────

  private agentName(address: string): string {
    return this.store.listAccounts().find((a) => a.address === address)?.label || address.slice(0, 10);
  }

  private footer(agent: string, unsubToken: string, sourceUrl: string | null): string {
    const op = this.config.storefront.operatorName.trim();
    const base = this.config.storefront.publicUrl.replace(/\/$/, "");
    return [
      "",
      "--",
      `This email was written and sent by ${agent}, an autonomous AI agent run by ${op}.`,
      ...(sourceUrl ? [`Your address was taken from ${sourceUrl}.`] : []),
      `${op}, ${this.cfg.mailingAddress.trim()}`,
      `To stop all email from ${op}'s agents: ${base}/u/${unsubToken} (or reply "unsubscribe").`,
    ].join("\n");
  }

  private fromHeader(agent: string): string {
    const op = this.config.storefront.operatorName.trim().replace(/["\\]/g, "");
    return `"${agent.replace(/["\\]/g, "")} (AI agent for ${op})" <${this.cfg.fromAddress}>`;
  }

  private messageId(threadId: string): string {
    return `<t.${threadId}.${randomBytes(6).toString("hex")}@${this.cfg.fromAddress.split("@")[1]}>`;
  }

  /** A first email to a business. */
  async sendFirst(
    addressRaw: string,
    input: { to: unknown; businessName: unknown; sourceUrl: unknown; whyRelevant: unknown; subject: unknown; body: unknown },
    now = Date.now(),
  ): Promise<{ threadId: string; sentToday: number; leftToday: number }> {
    const address = normalizeAddress(addressRaw);
    this.assertCanSend(address, now);
    const to = typeof input.to === "string" ? input.to.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(to)) throw new OutreachError("to must be one email address");
    const domain = to.split("@")[1]!;
    if (FREE_MAIL_DOMAINS.has(domain)) throw new OutreachError(`${domain} is a personal mailbox provider. First emails go only to a business's own domain.`, 422, "personal_address");
    if (to === this.cfg.fromAddress.toLowerCase()) throw new OutreachError("That is this host's own mailbox");
    const suppressed = this.isSuppressed(to);
    if (suppressed) throw new OutreachError(`${to} must not be emailed (${suppressed})`, 403, "suppressed");
    const businessName = clean(input.businessName, 120, "business_name");
    const sourceUrl = clean(input.sourceUrl, 500, "source_url");
    const whyRelevant = clean(input.whyRelevant, 300, "why_relevant (why this offer fits their business)");
    const subject = clean(input.subject, 120, "subject");
    const body = clean(input.body, 5000, "body", true);

    const since = new Date(now - this.cfg.recontactDays * 86_400_000).toISOString();
    const prior = this.store.db.prepare("SELECT address, created_at FROM email_threads WHERE contact = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1").get(to, since) as { address: string; created_at: string } | undefined;
    if (prior) {
      throw new OutreachError(
        prior.address === address
          ? `You already emailed ${to} on ${prior.created_at.slice(0, 10)}. Use reply_email on that conversation.`
          : `${to} was emailed by another agent on ${prior.created_at.slice(0, 10)}. One agent per business.`,
        409,
        "already_contacted",
      );
    }
    await this.confirmPublished(to, sourceUrl);
    // The page check took time; the limits may have moved.
    this.assertCanSend(address, now);

    const threadId = ulid();
    const token = randomBytes(24).toString("base64url");
    const agent = this.agentName(address);
    const mid = this.messageId(threadId);
    const base = this.config.storefront.publicUrl.replace(/\/$/, "");
    await this.opts.transport!.send({
      from: this.fromHeader(agent),
      to,
      subject,
      text: `${body}\n${this.footer(agent, token, sourceUrl)}\n`,
      messageId: mid,
      headers: {
        "List-Unsubscribe": `<${base}/u/${token}>, <mailto:${this.cfg.fromAddress}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Automaton-Agent": agent,
      },
    });
    const at = new Date(now).toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT OR REPLACE INTO email_contacts (address, domain, business_name, source_url, relevance, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(to, domain, businessName, sourceUrl, whyRelevant, at);
      this.store.db.prepare("INSERT INTO email_threads (id, address, contact, subject, status, unsub_hash, created_at, last_out_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)").run(threadId, address, to, subject, sha(token), at, at);
      this.store.db.prepare("INSERT INTO email_messages (id, thread_id, address, direction, message_id, subject, body, at) VALUES (?, ?, ?, 'out', ?, ?, ?, ?)").run(ulid(), threadId, address, mid, subject, body, at);
    })();
    const sent = this.sentToday(address, now);
    return { threadId, sentToday: sent, leftToday: Math.max(0, this.cfg.perAgentPerDay - sent) };
  }

  getThread(id: string): Thread | null {
    const r = this.store.db.prepare("SELECT * FROM email_threads WHERE id = ?").get(id);
    return r ? mapThread(r) : null;
  }

  messages(threadId: string): Message[] {
    return (this.store.db.prepare("SELECT * FROM email_messages WHERE thread_id = ? ORDER BY at, id").all(threadId) as any[]).map((r) => ({
      id: r.id, direction: r.direction, subject: r.subject, body: r.body, automatic: r.automatic === 1, at: r.at,
    }));
  }

  /** A reply in a conversation, or a follow-up when there has been no answer. */
  async reply(
    addressRaw: string,
    threadId: string,
    input: { body: unknown; attachments?: Array<{ filename: unknown; contentBase64: unknown }> },
    now = Date.now(),
  ): Promise<{ followUp: boolean; leftToday: number }> {
    const address = normalizeAddress(addressRaw);
    const t = this.getThread(threadId);
    if (!t || t.address !== address) throw new OutreachError(`No conversation ${threadId}`, 404, "not_found");
    this.assertCanSend(address, now);
    if (t.status === "unsubscribed" || t.status === "bounced" || t.status === "closed") throw new OutreachError(`This conversation is ${t.status}; do not email them again`, 409, "thread_closed");
    const suppressed = this.isSuppressed(t.contact);
    if (suppressed) throw new OutreachError(`${t.contact} must not be emailed (${suppressed})`, 403, "suppressed");
    const humanReplies = (this.store.db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE thread_id = ? AND direction = 'in' AND automatic = 0").get(threadId) as { n: number }).n;
    const followUp = humanReplies === 0;
    if (followUp) {
      if (t.followups >= this.cfg.maxFollowUps) throw new OutreachError(`They have not replied and you have sent ${t.followups} follow-up(s), the limit. Leave them be.`, 409, "followup_limit");
      const wait = this.cfg.followUpDays * 86_400_000;
      if (t.lastOutAt && now - new Date(t.lastOutAt).getTime() < wait) {
        throw new OutreachError(`Wait until ${new Date(new Date(t.lastOutAt).getTime() + wait).toISOString().slice(0, 16)}Z before following up`, 409, "followup_too_soon");
      }
    }
    const body = clean(input.body, 5000, "body", true);
    const files = (input.attachments ?? []).map((a) => {
      const filename = clean(a.filename, 100, "attachment filename").replace(/[^A-Za-z0-9._-]+/g, "-");
      if (typeof a.contentBase64 !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(a.contentBase64)) throw new OutreachError("attachment content must be base64");
      return { filename, content: Buffer.from(a.contentBase64, "base64") };
    });
    if (files.length > 5) throw new OutreachError("At most 5 attachments");
    if (files.reduce((n, f) => n + f.content.length, 0) > 10 * 1024 * 1024) throw new OutreachError("Attachments may total at most 10 MB", 413, "too_large");

    const ids = (this.store.db.prepare("SELECT message_id FROM email_messages WHERE thread_id = ? AND message_id IS NOT NULL ORDER BY at, id").all(threadId) as Array<{ message_id: string }>).map((r) => r.message_id);
    const contact = this.store.db.prepare("SELECT source_url FROM email_contacts WHERE address = ?").get(t.contact) as { source_url: string } | undefined;
    // Each email gets its own unsubscribe link; every one of them stays valid.
    const token = randomBytes(24).toString("base64url");
    const agent = this.agentName(address);
    const mid = this.messageId(threadId);
    const subject = /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;
    const base = this.config.storefront.publicUrl.replace(/\/$/, "");
    await this.opts.transport!.send({
      from: this.fromHeader(agent),
      to: t.contact,
      subject,
      text: `${body}\n${this.footer(agent, token, contact?.source_url ?? null)}\n`,
      messageId: mid,
      inReplyTo: ids.at(-1),
      references: ids.slice(-20),
      headers: {
        "List-Unsubscribe": `<${base}/u/${token}>, <mailto:${this.cfg.fromAddress}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Automaton-Agent": agent,
      },
      attachments: files,
    });
    const at = new Date(now).toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO email_messages (id, thread_id, address, direction, message_id, subject, body, attachments, at) VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?)").run(ulid(), threadId, address, mid, subject, body, files.length ? files.map((f) => f.filename).join(", ") : null, at);
      this.store.db.prepare("INSERT OR IGNORE INTO email_state (k, v) VALUES (?, ?)").run(`unsub:${sha(token)}`, threadId);
      this.store.db.prepare(`UPDATE email_threads SET last_out_at = ?, followups = followups + ? WHERE id = ?`).run(at, followUp ? 1 : 0, threadId);
    })();
    return { followUp, leftToday: Math.max(0, this.cfg.perAgentPerDay - this.sentToday(address, now)) };
  }

  // ─── Unsubscribe ─────────────────────────────────────────────

  threadForUnsubscribe(token: string): Thread | null {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const h = sha(token);
    const r = this.store.db.prepare("SELECT * FROM email_threads WHERE unsub_hash = ?").get(h) as any;
    if (r) return mapThread(r);
    const alt = this.store.db.prepare("SELECT v FROM email_state WHERE k = ?").get(`unsub:${h}`) as { v: string } | undefined;
    return alt ? this.getThread(alt.v) : null;
  }

  unsubscribe(contact: string, how: string): void {
    this.suppress(contact, `unsubscribed (${how})`);
    if (this.cfg.suppressDomainOnUnsubscribe) {
      const domain = contact.split("@")[1];
      if (domain && !FREE_MAIL_DOMAINS.has(domain)) this.suppress(`@${domain}`, `unsubscribed (${how}, whole business)`);
    }
  }

  // ─── Receiving ───────────────────────────────────────────────

  private findThread(m: IncomingMail): Thread | null {
    for (const ref of [m.inReplyTo, ...m.references].filter(Boolean) as string[]) {
      const r = this.store.db.prepare("SELECT thread_id FROM email_messages WHERE message_id = ? AND direction = 'out'").get(ref) as { thread_id: string } | undefined;
      if (r) return this.getThread(r.thread_id);
      const t = /^<t\.([0-9A-Z]{26})\./.exec(ref);
      if (t) {
        const th = this.getThread(t[1]!);
        if (th) return th;
      }
    }
    if (m.from) {
      const r = this.store.db.prepare("SELECT * FROM email_threads WHERE contact = ? ORDER BY created_at DESC LIMIT 1").get(m.from) as any;
      if (r) return mapThread(r);
    }
    return null;
  }

  async handleIncoming(m: IncomingMail): Promise<"bounce" | "unsubscribe" | "reply" | "ignored"> {
    if (m.bounce) {
      const failed = m.bounce.recipient ?? (this.findThread({ ...m, from: null })?.contact ?? null);
      if (failed) this.suppress(failed, "bounced");
      return "bounce";
    }
    const t = this.findThread(m);
    if (!t) return "ignored";
    // Only the newest lines count; quoted history below them may contain our own footer.
    const fresh = m.text.split(/\n(?:>|On .+wrote:|-----Original Message-----)/)[0]!.slice(0, 400);
    if (!m.automatic && (UNSUBSCRIBE_WORDS.test(fresh) || UNSUBSCRIBE_WORDS.test(m.subject) || /^\s*stop\s*$/i.test(fresh))) {
      this.unsubscribe(t.contact, "reply");
      return "unsubscribe";
    }
    const at = m.date;
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO email_messages (id, thread_id, address, direction, message_id, subject, body, automatic, at) VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?)").run(ulid(), t.id, t.address, m.messageId, m.subject.slice(0, 200), m.text.slice(0, 20_000), m.automatic ? 1 : 0, at);
      if (!m.automatic && t.status === "open") this.store.db.prepare("UPDATE email_threads SET status = 'replied' WHERE id = ?").run(t.id);
      this.store.db.prepare("UPDATE email_threads SET last_in_at = ? WHERE id = ?").run(at, t.id);
    })();
    // Wake the agent. The note names the conversation only; the stranger's text stays behind check_inbox.
    if (!m.automatic) {
      this.store.notify(t.address, `Email: ${t.contact} replied in conversation ${t.id} ("${t.subject.slice(0, 80)}"). Read it with check_inbox.`);
    }
    return "reply";
  }

  /** Read new mail from the mailbox. Safe to call repeatedly. */
  async poll(): Promise<{ replies: number; bounces: number; unsubscribes: number }> {
    const counts = { replies: 0, bounces: 0, unsubscribes: 0 };
    if (!this.opts.transport) return counts;
    const st = (k: string) => (this.store.db.prepare("SELECT v FROM email_state WHERE k = ?").get(k) as { v: string } | undefined)?.v ?? null;
    // The first poll only notes where the mailbox is: mail already there is not ours to act on.
    const r = await this.opts.transport.fetchNew(Number(st("imap_uid") ?? 0), st("imap_validity"));
    for (const m of r.messages) {
      const kind = await this.handleIncoming(m);
      if (kind === "reply") counts.replies++;
      if (kind === "bounce") counts.bounces++;
      if (kind === "unsubscribe") counts.unsubscribes++;
      // Saved per message, so a crash part-way does not handle the same mail twice.
      this.store.db.prepare("INSERT OR REPLACE INTO email_state (k, v) VALUES ('imap_uid', ?)").run(String(m.uid));
    }
    this.store.db.prepare("INSERT OR REPLACE INTO email_state (k, v) VALUES ('imap_uid', ?)").run(String(r.lastUid));
    this.store.db.prepare("INSERT OR REPLACE INTO email_state (k, v) VALUES ('imap_validity', ?)").run(r.uidValidity);
    return counts;
  }

  // ─── Agent views ─────────────────────────────────────────────

  /** Conversations with replies the agent has not seen, then marks them seen. */
  inbox(addressRaw: string, now = Date.now()): Array<Thread & { newMessages: Message[] }> {
    const address = normalizeAddress(addressRaw);
    const rows = this.store.db.prepare("SELECT * FROM email_threads WHERE address = ? AND last_in_at IS NOT NULL AND (agent_seen_at IS NULL OR last_in_at > agent_seen_at) ORDER BY last_in_at").all(address) as any[];
    const out = rows.map((r) => {
      const t = mapThread(r);
      const newMessages = this.messages(t.id).filter((m) => m.direction === "in" && (!r.agent_seen_at || m.at > r.agent_seen_at));
      return { ...t, newMessages };
    });
    const at = new Date(now).toISOString();
    for (const t of out) this.store.db.prepare("UPDATE email_threads SET agent_seen_at = ? WHERE id = ?").run(at, t.id);
    return out;
  }

  threadsOf(addressRaw: string, limit = 50): Thread[] {
    return (this.store.db.prepare("SELECT * FROM email_threads WHERE address = ? ORDER BY created_at DESC LIMIT ?").all(normalizeAddress(addressRaw), limit) as any[]).map(mapThread);
  }

  allThreads(limit = 200): Thread[] {
    return (this.store.db.prepare("SELECT * FROM email_threads ORDER BY COALESCE(last_in_at, last_out_at, created_at) DESC LIMIT ?").all(limit) as any[]).map(mapThread);
  }

  stats(addressRaw?: string, now = Date.now()) {
    const where = addressRaw ? "WHERE address = ?" : "";
    const args = addressRaw ? [normalizeAddress(addressRaw)] : [];
    const rows = this.store.db.prepare(`SELECT status, COUNT(*) AS n FROM email_threads ${where} GROUP BY status`).all(...args) as Array<{ status: string; n: number }>;
    const of = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    const contacted = rows.reduce((a, r) => a + r.n, 0);
    // Counted from the messages, so a business that replied and later unsubscribed still counts as a reply.
    const replied = (this.store.db
      .prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM email_messages WHERE direction = 'in' AND automatic = 0 ${addressRaw ? "AND address = ?" : ""}`)
      .get(...args) as { n: number }).n;
    return {
      contacted,
      replied,
      unsubscribed: of("unsubscribed"),
      bounced: of("bounced"),
      open: of("open"),
      sentToday: this.sentToday(addressRaw, now),
      perDay: addressRaw ? this.cfg.perAgentPerDay : this.cfg.hostPerDay,
      replyRate: contacted ? replied / contacted : 0,
    };
  }

  /** A dead agent's conversations end. */
  closeAgent(addressRaw: string): void {
    this.store.db.prepare("UPDATE email_threads SET status = 'closed' WHERE address = ? AND status IN ('open','replied')").run(normalizeAddress(addressRaw));
  }
}
