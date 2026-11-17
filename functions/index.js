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
  async () => { await runScan('schedule'); }
);

exports.runScanNow = onCall({ timeoutSeconds: 540, memory: '512MiB' }, async (req) => {
  const email = (req.auth?.token?.email || '').toLowerCase();
  if (!req.auth || !req.auth.token.email_verified || !TEAM.includes(email)) {
    throw new HttpsError('permission-denied', 'Not on the new business team');
  }
  return runScan(email);
});

// exported for local testing
exports._classify = classify;
exports._DEFAULT_QUERIES = DEFAULT_QUERIES;
