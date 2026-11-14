/**
 * Host Control Plane — Mail transport
 *
 * Sends through the creator's own mailbox over SMTP and reads replies from
 * the same mailbox over IMAP. Only the host holds the mailbox password;
 * agents never see it.
 *
 * The host never changes the mailbox: it does not mark messages read, move
 * or delete them. It remembers the last IMAP UID it has looked at instead,
 * so the creator's own mail client keeps working normally.
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;
  attachments?: Array<{ filename: string; content: Buffer }>;
}

export interface IncomingMail {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  to: string[];
  subject: string;
  text: string;
  date: string;
  /** Auto-Submitted, vacation responders and similar. */
  automatic: boolean;
  /** A delivery failure report, with the address that failed if it can be found. */
  bounce: { recipient: string | null } | null;
}

export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
  /**
   * Messages with UID above `afterUid`, oldest first, and the UID to pass next time.
   * When `lastValidity` is not the mailbox's current UIDVALIDITY (first run, or
   * the mailbox was rebuilt), nothing is returned: what is already there is
   * skipped, and only mail arriving from now on is read.
   */
  fetchNew(afterUid: number, lastValidity: string | null): Promise<{ uidValidity: string; lastUid: number; messages: IncomingMail[] }>;
  verify(): Promise<string>;
  close(): Promise<void>;
}

export interface MailboxSettings {
  smtpHost: string;
  smtpPort: number;
  /** true for implicit TLS (port 465); false uses STARTTLS, which is then required. */
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  password: string;
  /** Extra trusted certificate (PEM) for a mail server with a private CA. */
  ca?: string;
}

const addr = (s: string | undefined | null) => (s ? s.trim().toLowerCase() : null);

/** Pull the failed recipient out of a delivery status report, if it has one. */
function bounceRecipient(raw: string): string | null {
  const m = /^Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im.exec(raw) ?? /^Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im.exec(raw);
  return m ? m[1]!.toLowerCase() : null;
}

export async function parseIncoming(uid: number, raw: Buffer | string): Promise<IncomingMail> {
  const text = typeof raw === "string" ? raw : raw.toString("utf-8");
  const p: ParsedMail = await simpleParser(raw);
  const header = (k: string) => {
    const v = p.headers.get(k);
    return typeof v === "string" ? v : v == null ? "" : String((v as any).value ?? v);
  };
  const refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : [];
  const fromAddr = p.from?.value?.[0]?.address ?? null;
  const toList = (Array.isArray(p.to) ? p.to : p.to ? [p.to] : []).flatMap((t) => t.value.map((v) => v.address ?? "")).filter(Boolean);
  const contentType = String(p.headers.get("content-type") && (p.headers.get("content-type") as any).value || "");
  const isReport = /multipart\/report/i.test(contentType) && /delivery-status/i.test(text);
  const fromDaemon = /^(mailer-daemon|postmaster)@/i.test(fromAddr ?? "");
  const autoSubmitted = header("auto-submitted").toLowerCase();
  return {
    uid,
    messageId: p.messageId ?? null,
    inReplyTo: typeof p.inReplyTo === "string" ? p.inReplyTo : null,
    references: refs,
    from: addr(fromAddr),
    to: toList.map((t) => t.toLowerCase()),
    subject: p.subject ?? "",
    text: (p.text ?? "").slice(0, 20_000),
    date: (p.date ?? new Date()).toISOString(),
    automatic: (autoSubmitted !== "" && autoSubmitted !== "no") || Boolean(header("x-autoreply")) || /^(auto[- ]?reply|out of office|automatic reply)/i.test(p.subject ?? ""),
    bounce: isReport || fromDaemon ? { recipient: bounceRecipient(text) } : null,
  };
}

export class SmtpImapTransport implements MailTransport {
  private smtp: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly s: MailboxSettings) {
    this.smtp = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecure,
      // Never send the password over an unencrypted connection.
      requireTLS: !s.smtpSecure,
      auth: { user: s.username, pass: s.password },
      ...(s.ca ? { tls: { ca: s.ca } } : {}),
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.smtp.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      headers: mail.headers,
      attachments: mail.attachments,
    });
  }

  private imap(): ImapFlow {
    return new ImapFlow({
      host: this.s.imapHost,
      port: this.s.imapPort,
      secure: this.s.imapSecure,
      auth: { user: this.s.username, pass: this.s.password },
      logger: false,
      ...(this.s.ca ? { tls: { ca: this.s.ca } } : {}),
    });
  }

  async fetchNew(afterUid: number, lastValidity: string | null): Promise<{ uidValidity: string; lastUid: number; messages: IncomingMail[] }> {
    const client = this.imap();
    await client.connect();
    try {
      // readOnly: looking does not mark anything as read.
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      const validity = String(box.uidValidity);
      if (lastValidity !== validity) return { uidValidity: validity, lastUid: Math.max(0, Number(box.uidNext ?? 1) - 1), messages: [] };
      const from = afterUid + 1;
      const messages: IncomingMail[] = [];
      if (box.exists > 0 && (box.uidNext === undefined || from < Number(box.uidNext))) {
        for await (const m of client.fetch(`${from}:*`, { uid: true, source: true }, { uid: true })) {
          if (!m.source || m.uid < from) continue;
          messages.push(await parseIncoming(m.uid, m.source));
          if (messages.length >= 200) break;
        }
      }
      messages.sort((a, b) => a.uid - b.uid);
      return { uidValidity: validity, lastUid: messages.reduce((n, m) => Math.max(n, m.uid), afterUid), messages };
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async verify(): Promise<string> {
    await this.smtp.verify();
    const client = this.imap();
    await client.connect();
    try {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      return `SMTP login ok; IMAP INBOX has ${box.exists} messages`;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.smtp.close();
  }
}
