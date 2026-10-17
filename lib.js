const EMAIL = /[A-Za-z0-9._%+\x2d]+@[A-Za-z0-9\x2d]+(?:\.[A-Za-z0-9\x2d]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<![A-Za-z@])\+?\(?\d[\d ()./\x2d]{5,}\d(?![\d@])/g;
const LABEL = /^(tel|phone|mobile|fax|t|m)[:.]?$/i;
const SAME_SITE = { lax: 'Lax', strict: 'Strict', none: 'None', no_restriction: 'None' };

export function normalizeCookies(raw) {
  let list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (list && !Array.isArray(list)) list = list.cookies;
  if (!Array.isArray(list) || list.length === 0) throw new Error('No cookies found in the JSON');
  return list.filter((c) => c && c.name).map((c) => {
    const host = String(c.domain || '').match(/[a-z0-9.]*filmmakers\.eu/i);
    const cookie = {
      name: c.name,
      value: String(c.value),
      domain: host ? host[0].toLowerCase() : 'www.filmmakers.eu',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: Boolean(c.httpOnly),
      sameSite: SAME_SITE[String(c.sameSite || 'lax').toLowerCase()] || 'Lax',
    };
    const exp = c.expirationDate || c.expires;
    if (!c.session && typeof exp === 'number' && exp > 0) cookie.expires = Math.floor(exp);
    return cookie;
  });
}

export function stripPhones(text) {
  return String(text || '').replace(PHONE, '');
}

export function findEmails(text) {
  const out = [];
  for (const m of stripPhones(text).match(EMAIL) || []) {
    const e = m.toLowerCase();
    if (e.endsWith('filmmakers.eu') || e.endsWith('.png') || e.endsWith('.jpg')) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean);

export function pickBlock(candidates) {
  const good = candidates.filter((t) => findEmails(t).length > 0).sort((a, b) => a.length - b.length);
  return good.find((t) => lines(t).length >= 3) || good[0] || '';
}

export function cleanBlock(text) {
  return lines(stripPhones(text)).filter((l) => !LABEL.test(l) && !l.toLowerCase().startsWith('open agency')).join(' | ');
}

export function slugName(url) {
  const last = String(url).split('/').filter(Boolean).pop() || '';
  return last.split('_').join(' ').split(String.fromCharCode(45)).join(' ');
}
