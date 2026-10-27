/**
 * Email bodies are a small Markdown: # and ## headings, paragraphs, - lists,
 * **bold**, *italic*, [links](https://…) and [[Button]](https://…). Merge tags
 * are {{first_name|fallback}} and {{site_name}}. Output is a plain, single
 * column HTML email plus a text version, with the CAN-SPAM footer added here
 * so no template can leave it out.
 */
import type { SiteConfig, Template } from './config.ts';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** first_name and site_name always; workflows and bookings add contact and appointment fields. */
export type Vars = { first_name?: string | null; site_name: string; [key: string]: string | null | undefined };

export function merge(text: string, v: Vars): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g, (_, key: string, fallback = '') => {
    const val = (v as any)[key];
    return (typeof val === 'string' && val.trim()) ? val.trim() : fallback.trim();
  });
}

type Link = (url: string) => string;

function inline(s: string, color: string, link: Link): string {
  let out = esc(s);
  out = out.replace(/\[\[([^\]]+)\]\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) =>
    `<a href="${esc(link(url.replace(/&amp;/g, '&')))}" style="display:inline-block;background:${color};color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">${label}</a>`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) =>
    `<a href="${esc(link(url.replace(/&amp;/g, '&')))}" style="color:${color}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

function blocks(md: string): string[][] {
  return md.replace(/\r/g, '').split(/\n{2,}/).map((b) => b.split('\n').filter((l) => l.trim())).filter((b) => b.length);
}

export function toHtml(md: string, color: string, link: Link): string {
  return blocks(md).map((lines) => {
    const first = lines[0];
    if (/^##\s/.test(first)) return `<h2 style="font-size:18px;margin:24px 0 8px">${inline(first.slice(3), color, link)}</h2>`;
    if (/^#\s/.test(first)) return `<h1 style="font-size:22px;margin:0 0 12px">${inline(first.slice(2), color, link)}</h1>`;
    if (lines.every((l) => /^[-*]\s/.test(l))) return `<ul style="padding-left:20px;margin:0 0 16px">${lines.map((l) => `<li style="margin:4px 0">${inline(l.slice(2), color, link)}</li>`).join('')}</ul>`;
    return `<p style="margin:0 0 16px">${lines.map((l) => inline(l, color, link)).join('<br>')}</p>`;
  }).join('\n');
}

export function toText(md: string): string {
  return blocks(md).map((lines) => lines.map((l) => l
    .replace(/^#{1,2}\s/, '')
    .replace(/\[\[([^\]]+)\]\]\(([^)]+)\)/g, '$1: $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')).join('\n')).join('\n\n');
}

export type Rendered = { subject: string; html: string; text: string };

export function renderEmail(site: SiteConfig, t: Template, v: Vars, opts: { unsubscribeUrl: string; openPixelUrl?: string; link?: Link; reason?: string }): Rendered {
  const color = site.brandColor ?? '#111827';
  const link = opts.link ?? ((u: string) => u);
  const body = merge(t.body, v);
  const domain = site.origins[0]?.replace(/^https?:\/\//, '') ?? site.name;
  const footer = `${opts.reason ?? `You're getting this because you signed up at ${domain}.`} ${site.name}, ${site.address}.`;
  const pre = t.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(merge(t.preheader, v))}</div>` : '';
  const pixel = opts.openPixelUrl ? `<img src="${esc(opts.openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0">` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px"><tr><td style="padding:28px 28px 12px;font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
${toHtml(body, color, link)}
</td></tr></table>
<p style="max-width:560px;font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;margin:16px auto 0">${esc(footer)} <a href="${esc(opts.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a></p>
${pixel}</td></tr></table></body></html>`;
  const text = `${toText(body)}\n\n--\n${footer}\nUnsubscribe: ${opts.unsubscribeUrl}\n`;
  return { subject: merge(t.subject, v), html, text };
}
