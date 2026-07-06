// src/robots.js — good-faith robots.txt precheck.
//
// Added per the M0 ToS go/no-go decision (rider 3): the site has NO robots.txt
// today (https://www.gundam-gcg.com/robots.txt returns 404). If one ever appears
// and disallows the cards path for our user-agent, we abort the scrape loudly —
// exactly like a sanity-gate failure — rather than crawl against an explicit
// exclusion. A 404 / missing / unparseable robots.txt means "no restriction" and
// we proceed. This does NOT touch scraper.js logic, selectors, or rate limits.
const axios = require('axios');

// Turn a robots path pattern (supports * wildcard and trailing $ anchor) into a
// RegExp anchored at the start of the URL path, per the de-facto robots spec.
function patternToRegex(pattern) {
  let p = pattern;
  let end = '';
  if (p.endsWith('$')) { end = '$'; p = p.slice(0, -1); }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = p.split('*').map(esc).join('.*');
  return new RegExp('^' + rx + end);
}

// Parse robots.txt into groups of { agents:[], rules:[{type,value}] }.
// Consecutive User-agent lines share the rule block that follows them.
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current); }
      current.rules.push({ type: field, value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false; // sitemap, crawl-delay, host, etc. — irrelevant to allow/disallow
    }
  }
  return groups;
}

// Pick the rule block for our UA: the most specific matching agent token, else '*'.
function rulesForAgent(groups, userAgent) {
  const ua = userAgent.toLowerCase();
  let specific = null, specificLen = -1, star = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === '*') { if (!star) star = g; }
      else if (a && ua.includes(a) && a.length > specificLen) { specific = g; specificLen = a.length; }
    }
  }
  const g = specific || star;
  return g ? g.rules : [];
}

// Longest-match-wins; on an equal-length tie, Allow beats Disallow (robots spec).
// Empty-value rules are no-ops (an empty Disallow explicitly means "allow all").
function isPathAllowed(rules, path) {
  let best = null; // { len, type }
  for (const r of rules) {
    if (!r.value) continue;
    if (patternToRegex(r.value).test(path)) {
      const len = r.value.length;
      if (!best || len > best.len || (len === best.len && r.type === 'allow')) best = { len, type: r.type };
    }
  }
  return best ? best.type === 'allow' : true;
}

// Fetch robots.txt for baseUrl's host and abort (throw) if it disallows the cards
// path for our user-agent. Proceeds quietly on 404 / non-200 / fetch error.
async function assertScrapingAllowed(baseUrl, userAgent) {
  const robotsUrl = new URL('/robots.txt', baseUrl).toString();
  const cardsPath = (new URL(baseUrl).pathname.replace(/\/+$/, '')) || '/'; // e.g. /en/cards
  let text;
  try {
    const resp = await axios.get(robotsUrl, {
      headers: { 'User-Agent': userAgent, 'Accept': 'text/plain' },
      timeout: 15000,
      validateStatus: () => true
    });
    if (resp.status === 404) { console.log(`robots.txt: 404 (none present) at ${robotsUrl} — scraping allowed.`); return; }
    if (resp.status !== 200 || typeof resp.data !== 'string') {
      console.log(`robots.txt: HTTP ${resp.status} at ${robotsUrl} (no parseable rules) — proceeding.`);
      return;
    }
    text = resp.data;
  } catch (err) {
    console.log(`robots.txt: fetch failed (${err.message}) — proceeding (no rules to honor).`);
    return;
  }

  const rules = rulesForAgent(parseRobots(text), userAgent);
  const paths = [cardsPath, cardsPath + '/', cardsPath + '/index.php'];
  const blocked = paths.find((p) => !isPathAllowed(rules, p));
  if (blocked) {
    throw new Error(
      `ROBOTS: robots.txt at ${robotsUrl} now disallows "${blocked}" for our user-agent — ` +
      `aborting scrape to honor the exclusion. Review the file before scraping again.`
    );
  }
  console.log(`robots.txt: present at ${robotsUrl} and allows ${cardsPath} — OK.`);
}

module.exports = { assertScrapingAllowed, parseRobots, rulesForAgent, isPathAllowed };
