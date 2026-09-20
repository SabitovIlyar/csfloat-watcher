#!/usr/bin/env node
// Watches CSFloat for newly listed items in your float bands and sends a
// Telegram digest. No dependencies, Node 18+.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = join(ROOT, 'seen.json');

// --- config ---------------------------------------------------------------

function loadEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const API_KEY = process.env.CSFLOAT_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const RUN_ONCE = process.argv.includes('--once');
const ALERT_FIRST = process.argv.includes('--alert-first');
const TEST_TG = process.argv.includes('--test-telegram');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (cents) => '$' + (cents / 100).toFixed(2);
const stamp = () => new Date().toLocaleString();

// --- telegram -------------------------------------------------------------

// Telegram caps a message at 4096 chars; a busy digest can exceed that.
function chunk(text, max = 3500) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error('Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');
    return false;
  }
  let ok = true;
  for (const part of chunk(text)) {
    try {
      const res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          text: part,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        console.error('Telegram HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
        ok = false;
      }
    } catch (e) {
      console.error('Telegram request failed: ' + e.message);
      ok = false;
    }
  }
  return ok;
}

if (TEST_TG) {
  const sent = await telegram(
    '✅ <b>csfloat-watcher</b>\nСвязь есть, уведомления будут приходить сюда.\n<i>' + stamp() + '</i>'
  );
  console.log(sent ? 'Test message sent — check Telegram.' : 'Test message FAILED, see error above.');
  process.exit(sent ? 0 : 1);
}

if (!API_KEY) {
  console.error('CSFLOAT_API_KEY is not set. Put it in csfloat-watcher/.env');
  process.exit(1);
}

const CONFIG = JSON.parse(readFileSync(join(ROOT, 'watchlist.json'), 'utf8'));
const POLL_MS = (CONFIG.pollMinutes ?? 120) * 60000;

// --- state ----------------------------------------------------------------

let seen = new Set();
if (existsSync(SEEN_FILE)) {
  try {
    seen = new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8')));
  } catch {
    console.warn('seen.json is unreadable, starting fresh');
  }
}
let primed = seen.size > 0 || ALERT_FIRST;

function persistSeen() {
  // Keep the file from growing without bound; recent ids are all that matter.
  const ids = [...seen].slice(-5000);
  seen = new Set(ids);
  writeFileSync(SEEN_FILE, JSON.stringify(ids));
}

// --- api ------------------------------------------------------------------

let backoffMs = 0;

async function fetchListings(watch) {
  const params = new URLSearchParams({
    sort_by: 'most_recent',
    limit: '50',
    type: 'buy_now',
    market_hash_name: watch.market_hash_name,
  });
  if (watch.minFloat != null) params.set('min_float', String(watch.minFloat));
  if (watch.maxFloat != null) params.set('max_float', String(watch.maxFloat));
  if (watch.maxPrice != null) params.set('max_price', String(Math.round(watch.maxPrice * 100)));

  const res = await fetch('https://csfloat.com/api/v1/listings?' + params, {
    headers: { Authorization: API_KEY },
  });

  if (res.status === 429) {
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60000, 15 * 60000);
    throw new Error('rate limited, backing off ' + Math.round(backoffMs / 1000) + 's');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));

  backoffMs = 0;
  const body = await res.json();
  return Array.isArray(body) ? body : (body.data ?? []);
}

// Reference price used to judge whether a listing is actually a deal.
function referencePrice(l) {
  return (
    l.reference?.predicted_price ??
    l.reference?.base_price ??
    l.item?.scm?.price ??
    l.scm?.price ??
    null
  );
}

// --- digest ---------------------------------------------------------------

async function announce(batch) {
  const total = batch.reduce((n, g) => n + g.listings.length, 0);
  const lines = ['🧤 <b>CSFloat — ' + total + ' новых</b>  <i>' + stamp() + '</i>'];

  for (const { watch, listings } of batch) {
    lines.push('', '<b>' + watch.name + '</b>');
    // Cheapest first: that is the order you will act in.
    for (const l of [...listings].sort((a, b) => a.price - b.price)) {
      const ref = referencePrice(l);
      const pct = ref ? ((1 - l.price / ref) * 100).toFixed(1) : null;
      const float = l.item?.float_value;
      lines.push(
        '',
        '<b>' + money(l.price) + '</b>' +
          (pct != null ? (pct > 0 ? ' 🟢 −' + pct + '%' : ' 🔴 +' + -pct + '%') + ' от ' + money(ref) : '') +
          '\nfloat <code>' + (float != null ? float.toFixed(6) : '?') + '</code>' +
          ' · pattern <code>' + (l.item?.paint_seed ?? '?') + '</code>' +
          '\nhttps://csfloat.com/item/' + l.id
      );
    }
  }

  console.log('[' + stamp() + '] ' + total + ' new listing(s), sending to Telegram');
  await telegram(lines.join('\n'));
}

// --- main loop ------------------------------------------------------------

async function tick() {
  const batch = [];

  for (const watch of CONFIG.watches) {
    let listings;
    try {
      listings = await fetchListings(watch);
    } catch (e) {
      console.error('[' + watch.name + '] ' + e.message);
      if (backoffMs) await sleep(backoffMs);
      continue;
    }

    const fresh = [];
    for (const l of listings) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);

      // The API filters server-side, but re-check locally so a change in their
      // semantics cannot silently widen the band.
      // Auctions are explicitly unwanted: only listings you can buy outright.
      if (l.type && l.type !== 'buy_now') continue;
      if (l.auction_details != null) continue;

      const f = l.item?.float_value;
      if (watch.minFloat != null && !(f >= watch.minFloat)) continue;
      if (watch.maxFloat != null && !(f <= watch.maxFloat)) continue;
      if (watch.maxPrice != null && l.price > watch.maxPrice * 100) continue;
      if (watch.minDiscountPercent != null) {
        const ref = referencePrice(l);
        if (!ref || (1 - l.price / ref) * 100 < watch.minDiscountPercent) continue;
      }
      fresh.push(l);
    }

    if (!primed) {
      console.log('[' + watch.name + '] primed with ' + listings.length + ' existing listings');
    } else if (fresh.length) {
      batch.push({ watch, listings: fresh });
    }

    if (CONFIG.watches.length > 1) await sleep(1500); // stagger, be polite
  }

  if (batch.length) await announce(batch);
  else if (primed) console.log('[' + stamp() + '] nothing new');

  primed = true;
  persistSeen();
}

console.log('csfloat-watcher · telegram ' + (TG_TOKEN && TG_CHAT ? 'on' : 'OFF'));
for (const w of CONFIG.watches) {
  console.log(
    '  ' + w.name + '  float ' + (w.minFloat ?? '-') + '..' + (w.maxFloat ?? '-') +
    (w.maxPrice ? '  max $' + w.maxPrice : '')
  );
}
console.log(RUN_ONCE ? '  single sweep' : '  every ' + POLL_MS / 60000 + ' min');

if (RUN_ONCE) {
  await tick();
} else {
  while (true) {
    await tick();
    await sleep(POLL_MS);
  }
}
