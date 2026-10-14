import { log } from 'apify';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => a + Math.random() * (b - a);

export async function settle(p) {
  await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(rand(1500, 3000));
}

export function collectCards(p) {
  return p.evaluate(() => {
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/actors/"]')) {
      let u;
      try {
        u = new URL(a.href);
      } catch {
        continue;
      }
      const path = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
      const parts = path.split('/').filter(Boolean);
      const i = parts.indexOf('actors');
      if (i < 0 || parts.length !== i + 2 || ['search', 'new'].includes(parts[i + 1])) continue;
      const url = u.origin + path;
      const ls = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const name = ls.length ? ls[ls.length - 1] : '';
      const prev = out.get(url);
      if (!prev || (!prev.name && name)) out.set(url, { url, name });
    }
    return [...out.values()];
  });
}

const NEXT = [
  `a[rel=next]`,
  `a[aria-label*='next' i]`,
  `button[aria-label*='next' i]`,
  `li.next a`,
  `a.next`,
  `a:has-text('Next')`,
  `button:has-text('Next')`,
  `a:has-text('Load more')`,
  `button:has-text('Load more')`,
  `button:has-text('Show more')`,
  `a:has-text('\u203a')`,
  `a:has-text('\u00bb')`,
];
let advanceMethod = '';
export async function advance(p) {
  for (const s of NEXT) {
    const el = p.locator(s).first();
    if (!(await el.count())) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if ((await el.getAttribute('aria-disabled').catch(() => null)) === 'true') continue;
    if (await el.isDisabled().catch(() => false)) continue;
    try {
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: 10000 });
      if (advanceMethod !== s) log.info('Paging with: ' + s);
      advanceMethod = s;
      return s;
    } catch {
      /* try the next selector */
    }
  }
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  if (advanceMethod !== 'scroll') log.info('No next control found, scrolling instead');
  advanceMethod = 'scroll';
  return 'scroll';
}

function countOf(text) {
  const m = text.match(/of\s+([\d,]+)\s+results/i);
  return m ? m[1] : '';
}

export async function applyRegion(p, region) {
  const before = countOf(await p.evaluate(() => document.body.innerText));
  const ctl = p.getByText(/^\s*Regions/).first();
  if (!(await ctl.count())) throw new Error('Regions control not found');
  await ctl.click({ timeout: 10000 });
  await sleep(1200);
  const opt = p.locator('.select2-results__option').filter({ hasText: region }).first();
  if (!(await opt.count())) {
    const list = await p.evaluate(() => [...document.querySelectorAll('.select2-results__option')].map((e) => e.innerText.trim()).slice(0, 25));
    throw new Error('Region not in the list: ' + region + '. Options seen: ' + JSON.stringify(list));
  }
  await opt.click({ timeout: 10000 });
  await sleep(1000);
  await p.keyboard.press('Escape');
  await p
    .waitForFunction((prev) => !document.body.innerText.includes('of ' + prev + ' results'), before, { timeout: 20000 })
    .catch(() => log.warning('Result count did not change after choosing the region'));
  await settle(p);
  const text = await p.evaluate(() => document.body.innerText);
  const chip = text.split('\n').find((l) => l.startsWith('Regions:'));
  log.info('After region step. Chip: ' + chip + '. Results: ' + countOf(text) + ' (was ' + before + ')');
}
