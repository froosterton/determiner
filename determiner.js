const { Client } = require("discord.js-selfbot-v13");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");

// ----------------- CONFIG -----------------

const TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const MONITOR_CHANNEL_IDS = [
  "430203025659789343",
  "442709792839172099",
  "442709710408515605",
];

const VERIFIED_CHANNEL_ID = "1403167119071248548";

const ROLIMONS_API = "https://api.rolimons.com/items/v2/itemdetails";
const ROLIMONS_LEGACY_API = "https://www.rolimons.com/itemapi/itemdetails";

const MIN_ITEM_VALUE = 100000; // 100K

const ALLOWED_ROLES = [
  "Verified",
  "Nitro Booster",
  "200k Members",
  "Game Night",
  "Weeb",
  "Art Talk",
  "Music",
  "Pets",
  "Rolimon's News Pings",
  "Content Pings",
  "Roblox News Pings",
  "Trading News Pings",
  "Limited Pings",
  "UGC Limited Pings",
  "-Free UGC Limited Pings",
  "Free UGC Limited Game Pings",
  "Upcoming UGC Limiteds Ping",
  "Free UGC Event Pings",
  "Poll Pings",
  "Value Change Pings",
  "Projection Pings",
];

const BASE_ACRONYM_BLACKLIST = new Set([
  "mm", "dc", "w", "l", "f", "op", "pc", "nvm", "pm", "dm", "rn", "gg", "bb", "gl", "ty",
  "np", "lf", "ft", "nft", "id", "da", "fb", "sc", "rt", "ep", "hb",
  "ci", "aa", "dh", "rs", "gw", "ac", "iv", "es", "bm",
]);

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("WEBHOOK_URL is not set");
  process.exit(1);
}

// ----------------- GEMINI SETUP -----------------

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const visionModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// ----------------- DISCORD CLIENT -----------------

const client = new Client({ checkUpdate: false });

const processedMessages = new Set();
const checkedUsers = new Set();

const cachedVerifiedKeys = new Set();
let verifiedCacheReady = false;

// ----------------- ROLIMONS CACHE -----------------

let itemsCache = null;
let lastItemsFetch = 0;
let nameLookup = {};
let acronymLookup = {};
let acronymBlacklist = new Set();

// ----------------- HELPERS -----------------

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/'s/g, "s")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(name) {
  let s = String(name || "").toLowerCase().trim();
  s = s.replace(/\u2019/g, "'").replace(/\u2018/g, "'");
  s = s.replace(/'s/g, "s");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function tokenize(str) {
  return String(str || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function addToIndex(map, key, value) {
  if (!key) return;
  const arr = map.get(key);
  if (!arr) map.set(key, [value]);
  else arr.push(value);
}

function itemValue(d) {
  return d[3] && d[3] !== -1 ? d[3] : d[2] || 0;
}

function rebuildAcronymBlacklist() {
  acronymBlacklist = new Set();
  for (const word of BASE_ACRONYM_BLACKLIST) {
    if (acronymLookup[word]) {
      // keep as real item
    } else {
      acronymBlacklist.add(word);
    }
  }
}

function buildLookupTables(items) {
  const nl = {};
  const al = {};
  for (const [id, d] of Object.entries(items)) {
    const name = d[0] || "";
    const acr = (d[1] || "").trim().toLowerCase();
    nl[normalizeName(name)] = { id, data: d };
    if (acr) al[acr] = { id, data: d };
  }
  nameLookup = nl;
  acronymLookup = al;
  rebuildAcronymBlacklist();
}

async function getRolimonsData() {
  const now = Date.now();
  if (itemsCache && now - lastItemsFetch < 10 * 60 * 1000) {
    return { items: itemsCache, nameLookup, acronymLookup };
  }

  try {
    const res = await axios.get(ROLIMONS_API, { timeout: 15000 });
    if (res.data?.items) {
      itemsCache = res.data.items;
    } else {
      const legacy = await axios.get(ROLIMONS_LEGACY_API, {
        headers: { "User-Agent": "VisionScanner/1.0" },
        timeout: 15000,
      });
      if (legacy.data?.items) itemsCache = legacy.data.items;
    }
  } catch {
    if (itemsCache) return { items: itemsCache, nameLookup, acronymLookup };
    throw new Error("Failed to fetch Rolimons data");
  }

  lastItemsFetch = Date.now();
  buildLookupTables(itemsCache);
  return { items: itemsCache, nameLookup, acronymLookup };
}

function formatValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n >= 1_000_000) return `${Math.round(n / 100000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

async function getItemThumbnail(itemId) {
  try {
    const res = await axios.get("https://thumbnails.roblox.com/v1/assets", {
      params: {
        assetIds: itemId,
        size: "420x420",
        format: "Png",
        isCircular: false,
      },
      timeout: 5000,
    });
    if (res.data?.data?.[0]?.imageUrl) return res.data.data[0].imageUrl;
  } catch (err) {
    console.error("[Thumbnail] Error:", err.message);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildJumpLink(message) {
  const guildId = message.guild ? message.guild.id : "@me";
  return `https://discord.com/channels/${guildId}/${message.channel.id}/${message.id}`;
}

// ----------------- IMAGE EXTRACTION -----------------

function extractImageUrls(message) {
  const urls = [];
  for (const [, att] of message.attachments || []) {
    const ct = att.contentType || "";
    if (ct.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(att.name || "")) {
      urls.push(att.url);
    }
  }
  for (const embed of message.embeds || []) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }
  return urls;
}

async function downloadImageBase64(url) {
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  const mime = (resp.headers["content-type"] || "image/jpeg").split(";")[0].trim();
  return { base64: Buffer.from(resp.data).toString("base64"), mime };
}

// ----------------- GEMINI IMAGE PROMPTS -----------------

async function prescreenImage(base64, mime) {
  const prompt =
    "Look at this image carefully.\n" +
    "Is this image referencing a Roblox limited item? " +
    "Roblox limited items are special virtual accessories/gear that can be traded " +
    "between players (hats, faces, gear, etc.).\n\n" +
    "Signs that an image references a limited item:\n" +
    "- A Roblox trade window showing items\n" +
    "- An inventory showing items with RAP/value numbers\n" +
    "- Text mentioning specific Roblox limited item names or acronyms\n" +
    "- A Roblox avatar wearing recognizable limited items\n" +
    "- A Rolimons page or similar value-checking site\n\n" +
    "Answer with ONLY the word: yes or no";

  const res = await visionModel.generateContent([
    prompt,
    { inlineData: { data: base64, mimeType: mime } },
  ]);
  return res.response.text().trim().toLowerCase().startsWith("yes");
}

async function extractItemsFromImage(base64, mime) {
  const prompt =
    "This image is from a Discord post about Roblox limited items.\n" +
    "Your job is to identify EVERY Roblox limited item name mentioned or shown " +
    "anywhere in this image.\n\n" +
    "The image could be ANY of these formats:\n" +
    "- A Roblox trade window showing items on both sides\n" +
    "- An inventory or catalog screenshot\n" +
    "- A Rolimons value change notification\n" +
    "- A Rolimons item page or chart\n" +
    "- A text post or meme mentioning item names\n" +
    "- An avatar wearing limited items\n" +
    "- A screenshot of any Roblox-related site or app\n\n" +
    "For each item, extract:\n" +
    '- "name": the full item name exactly as displayed\n' +
    '- "value": highest numerical value shown (RAP, value, price). 0 if none visible.\n\n' +
    "Return ONLY a valid JSON array of objects.\n" +
    "Examples:\n" +
    '  [{"name":"Domino Crown","value":24000000}]\n' +
    '  [{"name":"Bighead","value":5000},{"name":"Goldrow","value":316}]\n\n' +
    "Important:\n" +
    "- Read EXACT item names from the image, do not guess.\n" +
    "- Commas in numbers (4,200,000) → plain number (4200000).\n" +
    "- Look EVERYWHERE in the image.\n" +
    "- If no items found, return: []";

  const res = await visionModel.generateContent([
    prompt,
    { inlineData: { data: base64, mimeType: mime } },
  ]);
  return res.response.text();
}

function parseGeminiResponse(raw) {
  let text = raw.trim();
  const backtickFence = "
