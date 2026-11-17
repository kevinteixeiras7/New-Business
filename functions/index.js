/**
 * Seventy7 New Business: Opportunity radar
 *
 * Every morning at 07:00 (London) this scans Google News for signals that a brand
 * may need a production partner (new marketing / ecommerce leadership, rebrands,
 * launches, funding, store openings, agency reviews), scores them, links them to
 * brands already in the pipeline, and writes them to the `signals` collection.
 *
 * runScanNow lets the team trigger the same scan from the Radar page.
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { XMLParser } = require('fast-xml-parser');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
setGlobalOptions({ region: 'europe-west2', maxInstances: 2 });

// Keep in step with firestore.rules
const TEAM = [
  'kevin.teixeira@seventy7group.com', 'kelly.primrose@seventy7group.com', 'kate.obrien@seventy7group.com',
  'emily.harvey@seventy7group.com', 'jayne.riley@seventy7group.com', 'kira.jones@seventy7group.com',
];

const DEFAULT_QUERIES = [
  // New leadership: the strongest trigger (new leaders often review suppliers)
  '"head of ecommerce" appointed fashion UK',
  '"chief marketing officer" appointed fashion brand',
  '"head of brand" appoints fashion OR beauty UK',
  'beauty brand appoints "marketing director" UK',
  '"creative director" appointed brand London fashion',
  'sportswear brand appoints marketing director',
  // Rebrands and relaunches
  'fashion brand rebrand UK',
  'beauty brand rebrand new identity',
  // Launches, funding, expansion
  'DTC fashion brand raises funding UK',
  'beauty brand secures investment UK',
  'brand opens London flagship store',
  'US fashion brand launches in UK',
  'activewear brand launch UK',
  'jewellery brand expansion UK',
  'homeware brand launch UK interiors',
  // Agency moves
  'brand appoints creative agency fashion',
  'retailer creative account review',
];

const SECTOR_WORDS = {
  'Beauty': /\b(beauty|skincare|skin care|cosmetic|makeup|make-up|fragrance|haircare|hair care)\b/i,
  'Sportswear': /\b(sportswear|activewear|athleisure|running|golf|football|sport|fitness|gym)\b/i,
  'Jewellery': /\b(jewellery|jewelry|jeweller)\b/i,
  'Interiors': /\b(interiors|homeware|furniture|home decor|homewares)\b/i,
  'Kidswear': /\b(kidswear|childrenswear|baby|children's)\b/i,
  'Accessories': /\b(footwear|shoes|eyewear|bags|handbag|accessories|sneaker)\b/i,
  'Mens Fashion': /\b(menswear)\b/i,
  'Womens Fashion': /\b(womenswear|fashion|clothing|apparel|label|retailer|lingerie|underwear|swimwear|dress(es)?)\b/i,
};

const TYPES = [
  ['Appointment', /\b(appoint|appointed|appoints|hires|hired|named|joins|promoted|new (chief|head|director)|steps up)\b/i, 4],
  ['Agency', /\b(agency|account review|pitch|roster|creative partner)\b/i, 4],
  ['Rebrand', /\b(rebrand|rebrands|rebranding|new identity|brand refresh|relaunch|relaunches|repositions?)\b/i, 3],
  ['Funding', /\b(raises|raised|funding|investment|invests|series [ab]|backed|acquires|acquired|acquisition)\b/i, 3],
  ['Expansion', /\b(opens|opening|flagship|store|expands|expansion|enters|arrives in|pop-up|first uk)\b/i, 2],
  ['Launch', /\b(launch|launches|launched|debut|debuts|unveils|collection|collaboration|collab|drops)\b/i, 2],
];
const ROLE_WORDS = /\b(ecommerce|e-commerce|ecom|digital|brand|marketing|creative|content|cmo|production)\b/i;
const NOISE = /\b(shares fell|stock price|share price|profit warning|lawsuit|recall|obituary|dies|died|arrested|court)\b/i;
// Brand names that are ordinary words, so only matched through their own brand search
const GENERIC = new Set(['office', 'lounge', 'coach', 'dune', 'represent', 'mac', 'elf', 'aries', 'arne', 'ando', 'huel', 'omnes', 'veet', 'wella', 'frkl']);

const parser = new XMLParser({ ignoreAttributes: false });
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function fetchNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-GB&gl=GB&ceid=GB:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Seventy7 radar)' } });
  if (!res.ok) throw new Error(`${res.status} for ${q}`);
  const xml = parser.parse(await res.text());
  let items = xml?.rss?.channel?.item || [];
  if (!Array.isArray(items)) items = [items];
  return items.map(it => ({
    title: String(it.title || '').trim(),
    link: String(it.link || '').trim(),
    source: typeof it.source === 'object' ? String(it.source['#text'] || '') : String(it.source || ''),
    published: it.pubDate ? new Date(it.pubDate).toISOString() : null,
  })).filter(i => i.title && i.link);
}

function classify(item, brands, queryBrand) {
  const title = item.title.replace(/\s+-\s+[^-]+$/, ''); // strip " - Source"
  if (NOISE.test(title)) return null;
  let type = 'News', base = 1;
  for (const [t, re, s] of TYPES) if (re.test(title)) { type = t; base = s; break; }

  let brand = queryBrand || null;
  if (!brand) {
    for (const b of brands) {
      if (b.key.length < 4 || GENERIC.has(b.key)) continue;
      if (b.re.test(title)) { brand = b; break; }
    }
  }
  let sector = brand?.sector || '';
  if (!sector) for (const [s, re] of Object.entries(SECTOR_WORDS)) if (re.test(title)) { sector = s; break; }

  let score = base;
  if (ROLE_WORDS.test(title)) score += 2;
  if (sector) score += 1;
  if (/\b(london|uk|british|britain)\b/i.test(title)) score += 1;
  if (brand) score += 2;
  if (brand && ['Contacted', 'Portfolio Sent', 'Meeting', 'Proposal'].includes(brand.stage)) score += 1;
  if (item.published && Date.now() - Date.parse(item.published) < 2 * 864e5) score += 1;
  score = Math.min(10, score);

  if (type === 'News' && !brand) return null; // generic noise
  if (score < 4) return null;
  if (queryBrand && !new RegExp(escRe(queryBrand.name.split(' ')[0]), 'i').test(title)) return null; // brand search drifted

  return {
    title: item.title, link: item.link, source: item.source, published: item.published,
    type, score, sector, brandId: brand?.id || null, brandGuess: brand ? brand.name : '',
  };
}

async function runScan(trigger) {
  const started = Date.now();
  const settings = (await db.doc('settings/radar').get()).data() || {};
  const queries = (settings.queries && settings.queries.length) ? settings.queries : DEFAULT_QUERIES;

  const brandSnap = await db.collection('brands').get();
  const brands = brandSnap.docs.map(d => {
    const x = d.data();
    const name = String(x.name || '').trim();
    return { id: d.id, name, key: name.toLowerCase(), sector: x.sector, stage: x.stage,
      re: new RegExp(`\\b${escRe(name)}\\b`, 'i') };
  }).filter(b => b.name);

  // Rotate through live brands so each gets its own news check every week or so
  const live = brands.filter(b => !['Lost', 'Paused'].includes(b.stage)).sort((a, b) => a.id.localeCompare(b.id));
  const perRun = 30;
  const offset = (settings.rotation || 0) % Math.max(1, live.length);
  const rotation = live.slice(offset, offset + perRun).concat(live.slice(0, Math.max(0, offset + perRun - live.length)));

  const jobs = [
    ...queries.map(q => ({ q, brand: null })),
    ...rotation.map(b => ({ q: `"${b.name}" (appoints OR appointed OR "head of" OR launch OR rebrand OR campaign OR opens OR raises)`, brand: b })),
  ];

  const found = new Map();
  let scanned = 0, failed = 0;
  for (let i = 0; i < jobs.length; i += 4) {
    const batch = jobs.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map(j => fetchNews(j.q)));
    results.forEach((r, k) => {
      if (r.status !== 'fulfilled') { failed++; logger.warn(r.reason?.message); return; }
      for (const item of r.value.slice(0, 15)) {
        scanned++;
        const sig = classify(item, brands, batch[k].brand);
        if (!sig) continue;
        const id = hash(sig.title.toLowerCase().replace(/\W+/g, ' ').slice(0, 90));
        const prev = found.get(id);
        if (!prev || prev.score < sig.score) found.set(id, { ...sig, query: batch[k].q });
      }
    });
    await new Promise(r => setTimeout(r, 400));
  }

  // Write only new signals; never overwrite something the team already handled
  let added = 0;
  const now = new Date().toISOString();
  const ids = [...found.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const refs = ids.slice(i, i + 100).map(id => db.doc(`signals/${id}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    snaps.forEach(s => {
      if (s.exists) return;
      batch.set(s.ref, { ...found.get(s.id), status: 'new', createdAt: now });
      added++;
    });
    await batch.commit();
  }

  // Tidy: drop untouched or dismissed signals older than 45 days
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString();
  const old = await db.collection('signals').where('createdAt', '<', cutoff).limit(400).get();
  const del = db.batch(); let removed = 0;
  old.docs.forEach(d => { if (d.data().status !== 'added') { del.delete(d.ref); removed++; } });
  if (removed) await del.commit();

  await db.doc('settings/radar').set({
    rotation: (offset + perRun) % Math.max(1, live.length),
    lastRun: now, lastRunBy: trigger, lastAdded: added,
  }, { merge: true });

  const out = { added, scanned, queries: jobs.length, failed, removed, seconds: Math.round((Date.now() - started) / 1000) };
  logger.info('Radar scan', out);
  return out;
}

exports.dailyRadar = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'Europe/London', timeoutSeconds: 540, memory: '512MiB' },
  async () => { await runScan('schedule'); await enrichSignals(80, 420000); }
);

exports.runScanNow = onCall({ timeoutSeconds: 540, memory: '512MiB' }, async (req) => {
  const email = (req.auth?.token?.email || '').toLowerCase();
  if (!req.auth || !req.auth.token.email_verified || !TEAM.includes(email)) {
    throw new HttpsError('permission-denied', 'Not on the new business team');
  }
  const out = await runScan(email);
  out.contacts = await enrichSignals(40, 200000);
  return out;
});


// ---------------------------------------------------------------------------
//  Contact finder: looks up a brand's website and the business inbox it
//  publishes (press, marketing, partnerships, hello). Only addresses printed on
//  the brand's own site are returned, never guessed personal emails.
// ---------------------------------------------------------------------------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const SKIP_HOSTS = /(instagram|facebook|tiktok|twitter|x\.com|linkedin|youtube|pinterest|wikipedia|amazon|asos|selfridges|harrods|johnlewis|zalando|farfetch|net-a-porter|ssense|endclothing|trustpilot|glassdoor|companieshouse|crunchbase|vogue|drapers|businessoffashion|reddit|duckduckgo|bing\.com|google\.)/i;
async function get(url, ms = 8000){
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, {headers: {'User-Agent': UA, 'Accept-Language': 'en-GB,en'}, redirect: 'follow', signal: c.signal});
    if (!r.ok) return null; const ct = r.headers.get('content-type') || '';
    if (!/html|text/.test(ct)) return null; return {url: r.url, html: (await r.text()).slice(0, 600000)}; }
  catch { return null; } finally { clearTimeout(t); }
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const brandWords = n => n.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !['the','and','of','ltd','london','uk','fc'].includes(w));
const decodeEnt = t => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
async function searchRaw(q){
  const out = [];
  const ddg = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
  if (ddg) for (const m of ddg.html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)){
    let u = m[1].replace(/&amp;/g, '&'); const k = u.match(/uddg=([^&]+)/); if (k) u = decodeURIComponent(k[1]);
    if (u.startsWith('//')) u = 'https:' + u; out.push({url: u, title: decodeEnt(m[2])});
  }
  if (!out.length){
    const bing = await get('https://www.bing.com/search?setlang=en-GB&cc=GB&q=' + encodeURIComponent(q));
    if (bing) for (const m of bing.html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) out.push({url: m[1].replace(/&amp;/g, '&'), title: decodeEnt(m[2])});
  }
  return out;
}
// A public LinkedIn profile for the right person, found through a web search (LinkedIn itself is never fetched)
async function findPerson(brand, person, role){
  const q = person ? `site:linkedin.com/in "${person}" ${brand}` : `site:linkedin.com/in "${brand}" ${role}`;
  const words = brandWords(brand);
  for (const r of await searchRaw(q)){
    if (!/linkedin\.com\/in\//.test(r.url)) continue;
    const t = r.title.replace(/\s*\|\s*LinkedIn.*$/i, '');
    const parts = t.split(/\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const name = parts[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (!/^[A-Za-zÀ-ÿ'’.-]+(\s+[A-Za-zÀ-ÿ'’.-]+){1,3}$/.test(name)) continue;
    const rest = parts.slice(1).join(' · ').toLowerCase();
    if (!words.some(w => rest.includes(w))) continue;
    if (person && !name.toLowerCase().includes(person.split(' ').pop().toLowerCase())) continue;
    const title = parts.length > 2 ? parts[1] : (parts[1].toLowerCase().includes(words[0] || '#') ? '' : parts[1]);
    return {name, title, url: r.url.split('?')[0]};
  }
  return null;
}
async function searchSites(q){
  const out = (await searchRaw(q)).map(r => r.url);
  return out.filter(u => /^https?:/.test(u) && !SKIP_HOSTS.test(hostOf(u)));
}
async function findWebsite(name, hint){
  if (hint) { const h = hostOf(/^https?:/.test(hint) ? hint : 'https://' + hint); if (h) return 'https://' + h; }
  const words = brandWords(name);
  const hits = await searchSites(`${name} official site`);
  const good = hits.find(u => words.some(w => hostOf(u).replace(/[^a-z0-9]/g, '').includes(w.replace(/[^a-z0-9]/g, ''))));
  if (good) return 'https://' + hostOf(good);
  const slug = words.join('');
  for (const tld of ['.com', '.co.uk', '.london']){
    const p = await get(`https://${slug}${tld}`, 5000);
    if (p && words.some(w => p.html.toLowerCase().includes(w))) return 'https://' + hostOf(p.url);
  }
  return '';
}
const RANK = [[/^(press|pr|media|publicity)/, 'Press inbox', 1], [/^(marketing|brand|partnerships?|collab|collabs|collaborations?|creative|content|social|influencer)/, 'Marketing inbox', 1],
  [/^(hello|hi|info|contact|enquiries|enquiry|studio|team|office|general|business|wholesale)/, 'General inbox', 2], [/^(customer|care|help|support|service|orders?|returns|shop|sales|cs)/, 'Customer service inbox', 3]];
const JUNK = /^(no-?reply|donotreply|privacy|gdpr|dpo|legal|abuse|webmaster|postmaster|careers|jobs|recruit|hr|accounts|invoices?|finance|unsubscribe)|sentry|wixpress|example|\.(png|jpg|gif|webp|svg)$/i;
function pickEmail(html, site){
  const base = hostOf(site).split('.').slice(-3).join('.');
  const found = new Set();
  for (const m of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) found.add(m[0].toLowerCase().replace(/\.$/, ''));
  const scored = [...found].filter(e => !JUNK.test(e)).map(e => {
    const local = e.split('@')[0], dom = e.split('@')[1];
    const own = dom.endsWith(base) || base.endsWith(dom) || brandWordsMatch(dom, base);
    const r = RANK.find(([re]) => re.test(local));
    return {email: e, kind: r ? r[1] : 'Inbox', score: (own ? 0 : 10) + (r ? r[2] : 2.5)};
  }).filter(x => x.score < 10).sort((a, b) => a.score - b.score);
  return scored[0] || null;
}
function brandWordsMatch(dom, base){ const a = dom.split('.')[0], b = base.split('.')[0]; return a.length > 3 && (a.includes(b) || b.includes(a)); }
async function findContact(name, hint){
  const site = await findWebsite(name, hint);
  if (!site) return {website: '', email: '', note: 'Could not find a website'};
  const paths = ['', '/contact', '/contact-us', '/pages/contact', '/pages/contact-us', '/press', '/pages/press', '/about', '/pages/about-us', '/customer-service'];
  let best = null;
  for (const p of paths){
    const pg = await get(site + p, 6000); if (!pg) continue;
    const e = pickEmail(pg.html, site);
    if (e && (!best || e.score < best.score)) best = {...e, source: pg.url};
    if (best && best.score <= 1) break;
  }
  return best ? {website: site, email: best.email, kind: best.kind, source: best.source} : {website: site, email: '', note: 'No published email on the site'};
}
const ROLE_FOR = {Appointment:'Head of Marketing', Agency:'Head of Marketing', Rebrand:'Brand Director', Funding:'Head of Marketing', Expansion:'Head of Ecommerce', Launch:'Head of Ecommerce', News:'Head of Marketing'};
function personInTitle(t){
  t = (t || '').replace(/\s+[-–|]\s+[^-–|]{2,40}$/, '');
  const pats = [/\b(?:appoints|appointed|names|named|hires|hired|taps|promotes|welcomes|recruits)\s+(?:former\s+[\w-]+\s+(?:boss|exec|executive|chief)\s+)?([A-Z][a-zà-ÿ'’-]+(?:\s+[A-Z][a-zà-ÿ'’-]+){1,2})\b/,
    /^([A-Z][a-zà-ÿ'’-]+(?:\s+[A-Z][a-zà-ÿ'’-]+){1,2})\s+(?:joins|named|appointed|to lead|steps up|promoted|takes over|moves to)\b/];
  for (const re of pats){ const m = t.match(re); if (m && !/^(New|Former|The|Chief|Head|Global|Senior|Group|Brand|Creative|Marketing|UK|Its|Ex)\b/.test(m[1])) return m[1]; }
  return '';
}
// Look up contact details for radar stories: the brand's published inbox, plus the most likely person on LinkedIn
async function enrichSignals(limit, budgetMs){
  const t0 = Date.now(), now = new Date().toISOString();
  const [sigs, brandSnap] = await Promise.all([db.collection('signals').where('status', '==', 'new').get(), db.collection('brands').get()]);
  const brands = new Map(brandSnap.docs.map(d => [d.id, d.data()]));
  const groups = new Map();
  for (const d of sigs.docs){
    const s = d.data(); if (s.contactTried) continue;
    const b = s.brandId && brands.get(s.brandId);
    const name = b ? b.name : (s.brandGuess || '');
    if (!name) continue;
    const k = name.toLowerCase();
    if (!groups.has(k)) groups.set(k, {name, website: b?.website || '', hasEmail: !!(b && (b.contacts || []).some(c => c.email)), refs: [], score: 0, sig: s});
    const g = groups.get(k); g.refs.push(d.ref);
    if (s.score > g.score || (s.type === 'Appointment' && g.sig.type !== 'Appointment')){ g.score = Math.max(g.score, s.score); if (s.type === 'Appointment' || s.score >= g.sig.score) g.sig = s; }
  }
  const todo = [...groups.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  let done = 0, emails = 0, people = 0, i = 0;
  const work = async () => {
    while (i < todo.length && Date.now() - t0 < budgetMs){
      const g = todo[i++];
      try {
        const named = g.sig.type === 'Appointment' ? personInTitle(g.sig.title) : '';
        const [c, p] = await Promise.all([g.hasEmail ? Promise.resolve({}) : findContact(g.name, g.website), findPerson(g.name, named, ROLE_FOR[g.sig.type] || 'Head of Marketing')]);
        const contact = {email: c.email || '', kind: c.kind || '', source: c.source || '', website: c.website || '', person: p || null, named: named || '', at: now};
        const batch = db.batch(); g.refs.forEach(r => batch.update(r, {contact, contactTried: now})); await batch.commit();
        done++; if (contact.email) emails++; if (p) people++;
      } catch (e){ logger.warn('enrich', g.name, e.message); }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  const out = {brands: done, emails, people, left: groups.size - done};
  logger.info('Radar contacts', out);
  return out;
}

exports.findContact = onCall({ timeoutSeconds: 120, memory: '256MiB', maxInstances: 4 }, async (req) => {
  const email = (req.auth?.token?.email || '').toLowerCase();
  if (!req.auth || !req.auth.token.email_verified || !TEAM.includes(email)) throw new HttpsError('permission-denied', 'Not on the new business team');
  const name = String(req.data?.name || '').slice(0, 120).trim();
  if (!name) throw new HttpsError('invalid-argument', 'Brand name needed');
  const r = await findContact(name, String(req.data?.website || '').slice(0, 200));
  logger.info('findContact', {name, found: !!r.email, website: r.website});
  return r;
});
exports._findContact = findContact;
exports._findPerson = findPerson;

// exported for local testing
exports._classify = classify;
exports._DEFAULT_QUERIES = DEFAULT_QUERIES;
