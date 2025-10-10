/*
 * Elvebyen – robust NFF-henter
 * Leser TABELL + KAMPER fra riktig underside og finner kolonner via tabell-headere.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const fs = require("fs-extra");
const path = require("path");

const TABELL_URL = "https://www.fotball.no/fotballdata/turnering/hjem/?fiksId=200088&underside=tabell";
const KAMPER_URL = "https://www.fotball.no/fotballdata/turnering/hjem/?fiksId=200088&underside=kamper";
const CLUB_NAME = "Elvebyen FK";
const OUTPUT_JSON = path.join(__dirname, "data", "elvebyen.json");

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const n = (s) => {
  const x = parseInt(String(s || "").replace(/[^0-9-]/g, ""), 10);
  return Number.isNaN(x) ? 0 : x;
};

/* ---------------- TABELL ---------------- */
async function fetchTable() {
  const { data: html } = await axios.get(TABELL_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  const $ = cheerio.load(html);

  const tableEl = $("table").first();
  if (!tableEl.length) throw new Error("Fant ingen tabell på TABELL_URL");

  // Finn kolonneindekser ved å lese <th>-ene
  const headers = [];
  tableEl.find("thead th").each((i, th) => headers.push(clean($(th).text()).toLowerCase()));

  // typisk: ["#", "lag", "s", "v", "u", "t", "+", "-", "+/-", "poeng"]
  const idx = (name, fallbacks = []) => {
    const names = [name, ...fallbacks].map((x) => x.toLowerCase());
    for (const nm of names) {
      const j = headers.findIndex((h) => h === nm || h.includes(nm));
      if (j !== -1) return j;
    }
    return -1;
  };

  const iLag = idx("lag");
  const iS   = idx("s", ["spilt","kamper"]);
  const iV   = idx("v", ["seire"]);
  const iU   = idx("u", ["uavgjort"]);
  const iT   = idx("t", ["tap"]);
  const iPlus = idx("+", ["mål+","for"]);
  const iMinus = idx("-", ["mål-","mot"]);
  const iPoeng = idx("poeng", ["p"]);

  if (iLag === -1 || iS === -1 || iV === -1 || iU === -1 || iT === -1 || iPlus === -1 || iMinus === -1 || iPoeng === -1) {
    throw new Error("Klarte ikke å gjenkjenne kolonne-headere på tabellsiden.");
  }

  const out = [];
  tableEl.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;

    const team = clean(tds.eq(iLag).text());
    if (!team) return;

    const p  = n(tds.eq(iS).text());
    const v  = n(tds.eq(iV).text());
    const u  = n(tds.eq(iU).text());
    const t  = n(tds.eq(iT).text());
    const gm = n(tds.eq(iPlus).text());
    const ga = n(tds.eq(iMinus).text());
    const gd = gm - ga;
    const pts = n(tds.eq(iPoeng).text());

    out.push({ team, p, v, u, t, gm, ga, gd, pts });
  });

  return out;
}

/* ---------------- TERMINLISTE ---------------- */
async function fetchMatches() {
  const { data: html } = await axios.get(KAMPER_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  const $ = cheerio.load(html);

  const tableEl = $("table").first();
  if (!tableEl.length) throw new Error("Fant ingen kamptabell på KAMPER_URL");

  const headers = [];
  tableEl.find("thead th").each((i, th) => headers.push(clean($(th).text()).toLowerCase()));

  // typisk: ["runde", "dato", "tid", "hjemmelag", "bortelag", "bane", "resultat"]
  const idx = (name, fallbacks = []) => {
    const names = [name, ...fallbacks].map((x) => x.toLowerCase());
    for (const nm of names) {
      const j = headers.findIndex((h) => h === nm || h.includes(nm));
      if (j !== -1) return j;
    }
    return -1;
  };

  const iDato   = idx("dato", ["dag"]);
  const iTid    = idx("tid", ["kl"]);
  const iHome   = idx("hjemmelag", ["hjemme"]);
  const iAway   = idx("bortelag", ["borte"]);
  const iBane   = idx("bane", ["arena","sted"]);
  const iRes    = idx("resultat", ["res"]);

  if (iDato === -1 || iTid === -1 || iHome === -1 || iAway === -1 || iBane === -1) {
    throw new Error("Klarte ikke å gjenkjenne kolonne-headere på terminlista.");
  }

  const out = [];
  tableEl.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;

    const dateText = clean(tds.eq(iDato).text());
    const timeText = clean(tds.eq(iTid).text());
    const home = clean(tds.eq(iHome).text());
    const away = clean(tds.eq(iAway).text());
    const venue = clean(tds.eq(iBane).text());

    let homeGoals = null, awayGoals = null;
    if (iRes !== -1) {
      const resText = clean(tds.eq(iRes).text());
      const m = resText.match(/(\d+)\s*-\s*(\d+)/);
      if (m) { homeGoals = n(m[1]); awayGoals = n(m[2]); }
    }

    const dtRaw = `${dateText} ${timeText}`.trim();
    const iso = dayjs(dtRaw, ["DD.MM.YYYY HH:mm","DD.MM.YYYY H:mm","YYYY-MM-DD HH:mm"], true);
    const kickoff = iso.isValid() ? iso.toISOString() : null;

    out.push({ dateText, timeText, kickoff, home, away, venue, homeGoals, awayGoals });
  });

  return out;
}

/* ---------------- MERGE & LAGRING ---------------- */
(async () => {
  try {
    const table = await fetchTable();
    const matches = await fetchMatches();

    const now = dayjs();
    const upcoming = matches.filter(m => !m.kickoff || dayjs(m.kickoff).isAfter(now)).slice(0, 20);
    const played   = matches.filter(m => m.homeGoals != null && m.awayGoals != null).slice(-20);
    const myMatches = matches.filter(m => [m.home, m.away].some(x => (x || "").toLowerCase().includes(CLUB_NAME.toLowerCase())));

    const existing = await fs.pathExists(OUTPUT_JSON) ? await fs.readJson(OUTPUT_JSON) : {};
    const next = { ...existing, table, matches: { all: matches, upcoming, played }, myMatches };

    await fs.ensureFile(OUTPUT_JSON);
    await fs.writeJson(OUTPUT_JSON, next, { spaces: 2 });

    console.log(`✅ Lagret tabell (${table.length}) og kamper (${matches.length}) → ${OUTPUT_JSON}`);
  } catch (e) {
    console.error("❌ FEIL:", e.message);
    process.exit(1);
  }
})();
