/*
 * Henter tabell og kamper fra fotball.no og skriver til data/elvebyen.json
 * Kjøres automatisk på Netlify via "prebuild".
 */

const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const fs = require("fs-extra");
const path = require("path");

// Lenker du ga meg:
const TABELL_URL = process.env.NFF_TABELL_URL || "https://www.fotball.no/fotballdata/turnering/hjem/?fiksId=200088";
const KAMPER_URL = process.env.NFF_KAMPER_URL || "https://www.fotball.no/fotballdata/turnering/hjem/?fiksId=200088&underside=kamper";
const CLUB_NAME = process.env.CLUB_NAME || "Elvebyen FK";

const OUTPUT_JSON = path.join(__dirname, "data", "elvebyen.json");

function n(v){ const x = parseInt(String(v).replace(/[^0-9-]/g,""),10); return Number.isNaN(x)?0:x; }

async function fetchTable(){
  const {data:html} = await axios.get(TABELL_URL,{headers:{ "User-Agent":"Mozilla/5.0" }});
  const $ = cheerio.load(html);
  const rows = $("table tbody tr");
  if(!rows.length) throw new Error("Fant ingen tabellrader – sjekk TABELL_URL");
  const out = [];
  rows.each((_,tr)=>{
    const tds = $(tr).find("td");
    if (tds.length < 8) return;
    const team = $(tds[1]).text().trim();
    const p = n($(tds[2]).text());
    const v = n($(tds[3]).text());
    const u = n($(tds[4]).text());
    const t = n($(tds[5]).text());
    const gm = n($(tds[6]).text());
    const ga = n($(tds[7]).text());
    const gd = gm - ga;
    const pts = n($(tds[tds.length - 1]).text());
    if(team) out.push({ team, p, v, u, t, gm, ga, gd, pts });
  });
  return out;
}

async function fetchMatches(){
  const {data:html} = await axios.get(KAMPER_URL,{headers:{ "User-Agent":"Mozilla/5.0" }});
  const $ = cheerio.load(html);
  const rows = $("table tbody tr");
  if(!rows.length) throw new Error("Fant ingen kamper – sjekk KAMPER_URL");
  const out = [];
  rows.each((_,tr)=>{
    const tds = $(tr).find("td");
    if (!tds.length) return;
    const dateText = $(tds[0]).text().trim();
    const timeText = (tds[1]?$(tds[1]).text().trim():"") || "";
    const home = (tds[2]?$(tds[2]).text().trim():"") || "";
    const away = (tds[3]?$(tds[3]).text().trim():"") || "";
    const venue = (tds[4]?$(tds[4]).text().trim():"") || "";
    const resText = tds[5]?$(tds[5]).text().trim():"";
    let homeGoals=null, awayGoals=null;
    const m = resText.match(/(\d+)\s*-\s*(\d+)/);
    if (m) { homeGoals=n(m[1]); awayGoals=n(m[2]); }
    const dtRaw = `${dateText} ${timeText}`.trim();
    const iso = dayjs(dtRaw, ["DD.MM.YYYY HH:mm","DD.MM.YYYY H:mm","YYYY-MM-DD HH:mm"], true);
    const kickoff = iso.isValid() ? iso.toISOString() : null;
    out.push({ dateText, timeText, kickoff, home, away, venue, homeGoals, awayGoals });
  });
  return out;
}

(async ()=>{
  try{
    const table = await fetchTable();
    const matches = await fetchMatches();
    const now = dayjs();
    const upcoming = matches.filter(m => !m.kickoff || dayjs(m.kickoff).isAfter(now)).slice(0,20);
    const played = matches.filter(m => m.homeGoals!=null && m.awayGoals!=null).slice(-20);
    const myMatches = matches.filter(m => [m.home,m.away].some(x => (x||"").toLowerCase().includes(CLUB_NAME.toLowerCase())));
    const existing = await fs.pathExists(OUTPUT_JSON) ? await fs.readJson(OUTPUT_JSON) : {};
    const next = { ...existing, table, matches:{ all:matches, upcoming, played }, myMatches };
    await fs.ensureFile(OUTPUT_JSON);
    await fs.writeJson(OUTPUT_JSON, next, { spaces: 2 });
    console.log(`✅ Lagret tabell (${table.length}) og kamper (${matches.length}) til ${OUTPUT_JSON}`);
  }catch(e){
    console.error("❌ FEIL:", e.message);
    process.exit(1);
  }
})();
