import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { normalizeCookies, findEmails, pickBlock, cleanBlock, slugName } from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const BLOCKED = /just a moment|attention required|access denied|forbidden|verify you are human/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

await Actor.init();
const input = (await Actor.getInput()) || {};
const startUrl = input.startUrl || 'https://www.filmmakers.eu/actor_profile_search/new';
const maxProfiles = input.maxProfiles || 0;
const maxPages = input.maxPages || 0;
const minD = input.minDelaySec ?? 3;
const maxD = Math.max(input.maxDelaySec ?? 8, minD);

if (!input.cookiesJson) await Actor.fail('cookiesJson is required. Paste the cookie export for www.filmmakers.eu.');
let cookies;
try {
  cookies = normalizeCookies(input.cookiesJson);
} catch (e) {
  await Actor.fail('Cookie JSON could not be read: ' + e.message);
}

const store = await Actor.openKeyValueStore('filmmakerseu');
const prior = input.startFromScratch ? null : await store.getValue('state');
const done = new Set((prior && prior.done) || []);
const saveState = () => store.setValue('state', { done: [...done], updated: new Date().toISOString() });
log.info(`Cookies loaded: ${cookies.length}. Profiles already done: ${done.size}.`);

let proxy;
if (input.useProxy) {
  const pc = await Actor.createProxyConfiguration();
  const u = new URL(await pc.newUrl());
  proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}
const launchOpts = { headless: true, proxy, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] };
let browser;
try {
  browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
} catch (e) {
  log.warning('Chrome channel unavailable, using bundled Chromium: ' + String(e.message).split('\n')[0]);
  browser = await chromium.launch(launchOpts);
}
const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
await context.addCookies(cookies);
const listing = await context.newPage();
const prof = await context.newPage();

async function snapshot(p, key) {
  try {
    await store.setValue(key + '_html', await p.content(), { contentType: 'text/html' });
    await store.setValue(key + '_png', await p.screenshot(), { contentType: 'image/png' });
  } catch (e) {
    log.warning('Snapshot failed: ' + e.message);
  }
}

async function settle(p) {
  await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(rand(1500, 3000));
}

async function guard(p, resp, label) {
  const title = await p.title().catch(() => '');
  const status = resp ? resp.status() : 0;
  if (status === 403 || status === 429 || BLOCKED.test(title)) {
    await snapshot(p, 'BLOCKED');
    throw new Error('BLOCKED on ' + label + ' (status ' + status + ', title ' + title + ')');
  }
  const url = p.url().toLowerCase();
  const pw = await p.locator('input[type=password]').count();
  if (url.includes('sign_in') || url.includes('/login') || pw > 0) {
    await snapshot(p, 'LOGGEDOUT');
    throw new Error('LOGGED OUT on ' + label + ' (url ' + url + ')');
  }
}

function collectCards(p) {
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
async function advance(p) {
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

let visited = 0;
let saved = 0;
let pageNo = 1;
let fatal = '';
try {
  const r0 = await listing.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(listing);
  await guard(listing, r0, 'listing');
  await snapshot(listing, 'RECON_page1');
  const bodyText = await listing.evaluate(() => document.body.innerText);
  const count = bodyText.match(/of\s+([\d,]+)\s+results/i);
  log.info('Site reports results: ' + (count ? count[1] : 'count not found') + '. Title: ' + (await listing.title()));

  const seen = new Set();
  let emptyAdvance = 0;
  let errorsInRow = 0;
  outer: while (true) {
    const cards = await collectCards(listing);
    if (pageNo === 1 && cards.length === 0) throw new Error('No profile links found on the first page, check the RECON_page1 snapshot');
    const fresh = cards.filter((c) => !seen.has(c.url));
    fresh.forEach((c) => seen.add(c.url));
    log.info(`Discovery page ${pageNo}: ${cards.length} cards, ${fresh.length} new`);
    if (fresh.length === 0) {
      emptyAdvance += 1;
      if (emptyAdvance >= 2) break;
    } else {
      emptyAdvance = 0;
    }
    for (const c of fresh) {
      if (done.has(c.url)) continue;
      if (maxProfiles && visited >= maxProfiles) break outer;
      visited += 1;
      try {
        const r = await prof.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await settle(prof);
        await guard(prof, r, c.url);
        const cands = await prof.evaluate(() => [...document.querySelectorAll('div,section,li,p,address,span')].map((e) => (e.innerText || '').trim()).filter((t) => t.includes('@') && t.length > 8 && t.length < 400));
        const block = pickBlock(cands);
        const emails = block ? findEmails(block) : [];
        const h1 = await prof.locator('h1').first().innerText({ timeout: 2000 }).catch(() => '');
        const name = h1 && !h1.toLowerCase().includes('filmmakers') ? h1.trim() : c.name || slugName(c.url);
        if (emails.length) {
          await Actor.pushData({ discoveryPage: pageNo, profileUrl: c.url, name, email: emails.join(', '), contactBlock: cleanBlock(block) });
          saved += 1;
          log.info(`Saved ${emails[0]} for ${name}`);
        } else {
          log.info(`No contact email for ${name}`);
        }
        done.add(c.url);
        errorsInRow = 0;
      } catch (e) {
        if (/BLOCKED|LOGGED OUT/.test(e.message)) throw e;
        errorsInRow += 1;
        log.warning(`Profile failed ${c.url}: ${e.message}`);
        if (errorsInRow >= 8) throw new Error('Too many profile errors in a row');
      }
      if (visited % 10 === 0) await saveState();
      await sleep(rand(minD, maxD) * 1000);
    }
    if (maxPages && pageNo >= maxPages) break;
    await advance(listing);
    pageNo += 1;
    await settle(listing);
  }
} catch (e) {
  fatal = e.message;
  log.error(fatal);
}

await saveState();
await browser.close().catch(() => {});
const summary = { visited, saved, discoveryPages: pageNo, stoppedBecause: fatal || 'finished or limit reached' };
await Actor.setValue('SUMMARY', summary);
log.info('Summary ' + JSON.stringify(summary));
if (fatal) await Actor.fail(fatal);
await Actor.exit();
