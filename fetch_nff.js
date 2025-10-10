/*
 * Elvebyen – robust NFF-henter (med bedre feilmeldinger)
 */

const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const fs = require("fs-extra");
const path = require("path");

const TABELL_URL = "https://www.fotball.no/fotballdata/turnering/hjem/?fiksId=200088&underside=tabell";
const KAMPER_URL = "https://www.fotball.no/fotballdata/turnering/hjem/?fiksId=200088&underside=kamper";
const CLUB_NAME  = "Elvebyen FK";
const OUTPUT_JSON = path.join(__dirname, "data", "elvebyen.json");

const UA = { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" } };
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const n = (s) => { const x = parseInt(String(s||"").replace(/[^0-9-]/g,""),10); return Number.isNaN(x) ? 0 : x; };

// Hjelper: finn tabell + kolonneindekser robust
function findTableWithHeader($, wantHeaders=[]) {
  const tables = $("table");
  let found = null;
  tables.each((_, t) => {
    const ths = $(t).find("thead th");
    if (!ths.length) return;
    const headers = [];
    ths.each((i, th) => headers.push(clean($(th).text()).toLowerCase()));
    // Sjekk at minst halvparten av ønskede headere finnes
    const hits = wantHeaders.filter(w => headers.some(h => h === w || h.includes(w))).length;
    if (hits >= Math.ceil(wantHeaders.length/2)) {
      found = { el: $(t), headers };
      return false; // break
    }
  });
  return found;
}

/* ========== TABELL ========== */
async function fetchTable() {
  const { data: html } = await axios.get(TABELL_URL, UA);
  const $ = cheerio.load(html);

  // Finn tabell som ligner på standings
  let t = findTableWithHeader($, ["lag","poeng","s","v","u","t","+","-","+/-"]);
  if (!t) {
    // fallback: første tabell med mange rader
    const el = $("table").first();
    if (!el.length) throw new Error("Fant ingen tabell på tabell-siden.");
    t = { el, headers: [] };
  }

  // Lag indeksoppslag
  const headers = t.headers;
  const idx = (name, alt=[]) => {
    const names = [name, ...alt].map(x => x.toLowerCase());
    for (const nm of names) {
      const j = headers.findIndex(h => h === nm || h.includes(nm));
      if (j !== -1) return j;
    }
    return -1;
  };

  let iLag = idx("lag");
  let iS   = idx("s",["spilt","kamper"]);
  let iV   = idx("v",["seire"]);
  let iU   = idx("u",["uavgjort"]);
  let iT   = idx("t",["tap"]);
  let iPlus = idx("+",["mål+","for"]);
  let iMinus= idx("-",["mål-","mot"]);
  let iPoeng= idx("poeng",["p"]);

  // hvis ingen headere: anta standard rekkefølge
  const assume = (i, def) => i === -1 ? def : i;
  iLag   = assume(iLag, 1);
  iS     = assume(iS,   2);
  iV     = assume(iV,   3);
  iU     = assume(iU,   4);
  iT     = assume(iT,   5);
  iPlus  = assume(iPlus,6);
  iMinus = assume(iMinus,7);
  iPoeng = assume(iPoeng, headers.length ? headers.length-1 : 9);

  const out = [];
  t.el.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;
    const team = clean(tds.eq(iLag).text());
    if (!team) return;
    const p  = n(tds.eq(iS).text());
    const v  = n(tds.eq(iV).text());
    const u  = n(tds.eq(iU).text());
    const tt = n(tds.eq(iT).text());
    const gm = n(tds.eq(iPlus).text());
    const ga = n(tds.eq(iMinus).text());
    const gd = gm - ga;
    const pts= n(tds.eq(iPoeng).text());
    out.push({ team, p, v, u, t: tt, gm, ga, gd, pts });
  });

  if (!out.length) throw new Error("Tabell: Fant ingen rader – markup har trolig endret seg.");
  return out;
}

/* ========== KAMPER ========== */
async function fetchMatches() {
  const { data: html } = await axios.get(KAMPER_URL, UA);
  const $ = cheerio.load(html);

  let t = findTableWithHeader($, ["dato","tid","hjemmelag","bortelag","bane","resultat"]);
  if (!t) {
    const el = $("table").first();
    if (!el.length) throw new Error("Fant ingen kamptabell på kampsiden.");
    t = { el, headers: [] };
  }

  const headers = t.headers;
  const idx = (name, alt=[]) => {
    const names = [name, ...alt].map(x => x.toLowerCase());
    for (const nm of names) {
      const j = headers.findIndex(h => h === nm || h.includes(nm));
      if (j !== -1) return j;
    }
    return -1;
  };

  // Mange lister har først en "Runde"-kolonne → vi identifiserer kolonner via headere når mulig
  let iDato = idx("dato",["dag"]);
  let iTid  = idx("tid",["kl"]);
  let iHome = idx("hjemmelag",["hjemme"]);
  let iAway = idx("bortelag",["borte"]);
  let iBane = idx("bane",["arena","sted"]);
  let iRes  = idx("resultat",["res"]);

  // Fallback hvis thead mangler: anta [Runde, Dato, Tid, Hjemme, Borte, Bane, Resultat?]
  const assume = (i, def) => i === -1 ? def : i;
  iDato = assume(iDato, 1);
  iTid  = assume(iTid,  2);
  iHome = assume(iHome, 3);
  iAway = assume(iAway, 4);
  iBane = assume(iBane, 5);

  const out = [];
  t.el.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 6) return;

    const dateText = clean(tds.eq(iDato).text());
    const timeText = clean(tds.eq(iTid).text());
    const home = clean(tds.eq(iHome).text());
    const away = clean(tds.eq(iAway).text());
    const venue= clean(tds.eq(iBane).text());

    let homeGoals=null, awayGoals=null;
    if (iRes !== -1 && tds.eq(iRes).length) {
      const resText = clean(tds.eq(iRes).text());
      const m = resText.match(/(\d+)\s*-\s*(\d+)/);
      if (m) { homeGoals = n(m[1]); awayGoals = n(m[2]); }
    }

    const dtRaw = `${dateText} ${timeText}`.trim();
    const iso = dayjs(dtRaw, ["DD.MM.YYYY HH:mm","DD.MM.YYYY H:mm","YYYY-MM-DD HH:mm"], true);
    const kickoff = iso.isValid() ? iso.toISOString() : null;

    if (home || away) out.push({ dateText, timeText, kickoff, home, away, venue, homeGoals, awayGoals });
  });

  if (!out.length) throw new Error("Kamper: Fant ingen rader – markup har trolig endret seg.");
  return out;
}

/* ========== MERGE & LAGRE ========== */
(async () => {
  try {
    console.log("🔎 Henter tabell fra:", TABELL_URL);
    const table = await fetchTable();
    console.log("   OK, lag:", table.length);

    console.log("🔎 Henter kamper fra:", KAMPER_URL);
    const matches = await fetchMatches();
    console.log("   OK, kamper:", matches.length);

    const now = dayjs();
    const upcoming = matches.filter(m => !m.kickoff || dayjs(m.kickoff).isAfter(now)).slice(0, 20);
    const played   = matches.filter(m => m.homeGoals != null && m.awayGoals != null).slice(-20);
    const myMatches= matches.filter(m => [m.home,m.away].some(x => (x||"").toLowerCase().includes(CLUB_NAME.toLowerCase())));

    const existing = await fs.pathExists(OUTPUT_JSON) ? await fs.readJson(OUTPUT_JSON) : {};
    const next = { ...existing, table, matches: { all: matches, upcoming, played }, myMatches };

    await fs.ensureFile(OUTPUT_JSON);
    await fs.writeJson(OUTPUT_JSON, next, { spaces: 2 });
    console.log(`✅ Lagret til ${OUTPUT_JSON}`);
  } catch (e) {
    console.error("❌ FEIL:", e.message);
    process.exit(1);
  }
})();
