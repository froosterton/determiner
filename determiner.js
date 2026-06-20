const { Client } = require("discord.js-selfbot-v13");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

// ----------------- CONFIG -----------------

const TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const MONITOR_CHANNEL_IDS = [
  "430203025659789343",
  "442709792839172099",
  "442709710408515605",
];

const VERIFIED_CHANNEL_ID = "1403167119071248548";

const ROLIMONS_API = "https://api.rolimons.com/items/v2/itemdetails";

const MIN_ITEM_VALUE = 100000; // 100K

const ALLOWED_ROLES = [
  "Novice",
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

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("WEBHOOK_URL is not set");
  process.exit(1);
}

// ----------------- CLAUDE SETUP -----------------

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ----------------- DISCORD CLIENT -----------------

const client = new Client({ checkUpdate: false });

const processedMessages = new Set();
// track users we've already *checked* once (per runtime)
const checkedUsers = new Set();

// ---- VERIFIED CACHE (like your 2nd script) ----
const cachedVerifiedKeys = new Set(); // stores Discord IDs primarily
let verifiedCacheReady = false;

// ----------------- ROLIMONS CACHE -----------------

let itemsCache = null;
let lastItemsFetch = 0;

// indexes store ARRAYS, not single entries
let acronymIndex = null; // Map<string, Array<{id, details}>>
let nameIndex = null; // Map<string, Array<{id, details}>>

// ----------------- HELPERS -----------------

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function buildIndexes(items) {
  acronymIndex = new Map();
  nameIndex = new Map();

  for (const [id, details] of Object.entries(items)) {
    const name = details[0] || "";
    const acronym = details[1] || "";

    const normName = normalize(name);
    const normAcr = normalize(acronym);

    const entry = { id, details };

    // multiple items can share same acronym/name key → store arrays
    if (normAcr) addToIndex(acronymIndex, normAcr, entry);
    if (normName) addToIndex(nameIndex, normName, entry);
  }
}

async function getRolimonsData() {
  const now = Date.now();

  if (itemsCache && now - lastItemsFetch < 10 * 60 * 1000) {
    return { items: itemsCache, acronymIndex, nameIndex };
  }

  const res = await axios.get(ROLIMONS_API);
  if (!res.data || !res.data.items) {
    throw new Error("Invalid Rolimons API response");
  }

  itemsCache = res.data.items;
  lastItemsFetch = now;
  buildIndexes(itemsCache);

  return { items: itemsCache, acronymIndex, nameIndex };
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
    });

    const data = res.data;
    if (data?.data?.[0]?.imageUrl) return data.data[0].imageUrl;
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

// ----------------- VERIFIED CACHE HELPERS -----------------

function extractDiscordIdFromEmbed(embed) {
  const regex = /discord id[:\s]*([0-9]{5,})/i;

  if (embed.description) {
    const m = embed.description.match(regex);
    if (m) return m[1].trim();
  }

  if (embed.fields?.length) {
    for (const field of embed.fields) {
      const text =
        (field.name ? String(field.name) + "\n" : "") +
        (field.value ? String(field.value) : "");
      const m = text.match(regex);
      if (m) return m[1].trim();
    }
  }

  return null;
}

// Optional fallback for old-style embeds that only store "Discord: name"
function extractDiscordTagFromEmbed(embed) {
  // fields
  if (embed.fields?.length) {
    for (const f of embed.fields) {
      const nm = String(f.name || "").replace(/\*\*/g, "").trim().toLowerCase();
      if (nm.includes("discord")) {
        const v = String(f.value || "").trim();
        return v || null;
      }
    }
  }
  // description lines
  if (embed.description) {
    const lines = embed.description.split("\n");
    for (let line of lines) {
      line = line.replace(/\*\*/g, "").trim();
      if (line.toLowerCase().startsWith("discord:")) {
        return line.split(":").slice(1).join(":").trim() || null;
      }
    }
  }
  return null;
}

function addVerifiedFromMessage(msg) {
  if (!msg.embeds?.length) return;

  for (const embed of msg.embeds) {
    const id = extractDiscordIdFromEmbed(embed);
    if (id) {
      cachedVerifiedKeys.add(id); // ID-only mode (best)
      continue;
    }

    // OPTIONAL: if you want old-style "Discord:" entries to also dedupe
    // uncomment next 2 lines:
    // const tag = extractDiscordTagFromEmbed(embed);
    // if (tag) cachedVerifiedKeys.add(tag.toLowerCase());
  }
}

async function loadVerifiedCache(maxMessages = Infinity) {
  const channel =
    client.channels.cache.get(VERIFIED_CHANNEL_ID) ||
    (await client.channels.fetch(VERIFIED_CHANNEL_ID).catch(() => null));

  if (!channel) {
    console.log("Could not fetch verified channel.");
    return;
  }

  console.log("[VerifiedCache] Loading ALL messages into cache...");

  try {
    let lastId = null;
    let fetched = 0;
    let batch = 0;

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      batch++;

      if (messages.size === 0) break;

      messages.forEach((m) => addVerifiedFromMessage(m));

      fetched += messages.size;
      if (fetched >= maxMessages) break;

      const newLastId = messages.last()?.id;
      if (!newLastId || newLastId === lastId) break;

      lastId = newLastId;

      // small delay to avoid rate limits
      await sleep(350);
    }

    verifiedCacheReady = true;
    console.log(
      `[VerifiedCache] Ready. Cached keys: ${cachedVerifiedKeys.size}`
    );
  } catch (err) {
    console.error("Error during verified cache load:", err?.message || err);
  }
}

// ----------------- ITEM MATCHING (FIXED) -----------------

function scoreCandidateAgainstText(entry, msgNorm, msgTokensSet) {
  const details = entry.details;
  const name = details[0] || "";
  const acronym = details[1] || "";

  const normName = normalize(name);
  const normAcr = normalize(acronym);

  let score = 0;

  // Strongest: acronym as a whole token
  if (normAcr && msgTokensSet.has(normAcr)) score += 300;

  // Strong: full name phrase present
  if (normName && msgNorm.includes(normName)) score += 260;

  // Medium: token overlap with name
  const nameToks = tokenize(normName);
  if (nameToks.length) {
    let hit = 0;
    for (const t of nameToks) {
      if (t.length <= 2) continue;
      if (msgTokensSet.has(t)) hit++;
    }
    score += hit * 18;

    // bonus if most tokens hit
    if (hit >= Math.max(2, Math.floor(nameToks.length * 0.7))) score += 40;
  }

  // Slight preference for longer / more specific names when tied
  score += Math.min(30, Math.floor(normName.length / 4));

  return score;
}

function pickBestFromCandidates(candidates, messageText) {
  if (!candidates?.length) return null;

  const msgNorm = normalize(messageText);
  const msgTokensSet = new Set(tokenize(messageText).map((t) => normalize(t)));

  let best = null;
  let bestScore = -1;

  for (const entry of candidates) {
    const s = scoreCandidateAgainstText(entry, msgNorm, msgTokensSet);
    if (s > bestScore) {
      bestScore = s;
      best = entry;
    }
  }

  // require a minimum score so we don’t pick random junk
  if (bestScore < 120) return null;
  return best;
}

function findBestItemMatch(items, messageText, aiHintText) {
  const msgNorm = normalize(messageText);
  const msgTokens = tokenize(messageText).map((t) => normalize(t));
  const msgTokensSet = new Set(msgTokens);

  const hintNorm = normalize(aiHintText || "");

  const candidates = [];

  // 1) If Claude returned something, try:
  //    - exact acronym token candidates
  //    - exact name key candidates
  if (hintNorm) {
    const acHits = acronymIndex?.get(hintNorm);
    const nmHits = nameIndex?.get(hintNorm);
    if (acHits?.length) candidates.push(...acHits);
    if (nmHits?.length) candidates.push(...nmHits);
  }

  // 2) Also gather candidates from tokens in the ACTUAL MESSAGE
  for (const tok of msgTokens) {
    const hits = acronymIndex?.get(tok);
    if (hits?.length) candidates.push(...hits);
  }

  // 3) De-dup candidate list by item id
  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    uniq.push(c);
  }

  // 4) Pick best candidate by scoring against message text
  let best = pickBestFromCandidates(uniq, messageText);
  if (best) return best;

  // 5) Fallback: broad scan (slower but very accurate when hints fail)
  //    (still ok; Rolimons item list size is manageable)
  let bestGlobal = null;
  let bestScore = -1;
  const msgTokensSet2 = new Set(msgTokens);

  for (const [id, details] of Object.entries(items)) {
    const entry = { id, details };
    const s = scoreCandidateAgainstText(entry, msgNorm, msgTokensSet2);
    if (s > bestScore) {
      bestScore = s;
      bestGlobal = entry;
    }
  }

  if (bestScore < 140) return null;
  return bestGlobal;
}

// ----------------- DISCORD EVENTS -----------------

client.on("ready", async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  console.log(`[Monitor] Watching channels: ${MONITOR_CHANNEL_IDS.join(", ")}`);
  console.log(`[Monitor] Verified cache channel: ${VERIFIED_CHANNEL_ID}`);

  await loadVerifiedCache(); // loads entire history like your 2nd script
});

client.on("messageCreate", async (message) => {
  try {
    // Keep cache updated live: if a new embed appears in the verified channel, cache it.
    if (message.channel.id === VERIFIED_CHANNEL_ID) {
      addVerifiedFromMessage(message);
      return;
    }

    if (!verifiedCacheReady) return;

    // only monitor configured channels
    if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
    if (message.author.bot) return;
    if (!message.content?.trim()) return;
    if (!message.guild) return;

    // dedupe on the actual Discord ID (best)
    const authorKey = message.author.id;

    // if already logged in the verified cache, skip
    if (cachedVerifiedKeys.has(authorKey)) {
      return;
    }

    // don't double-process the same Discord message
    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);

    // don't check more than one message per user per runtime
    if (checkedUsers.has(authorKey)) return;
    checkedUsers.add(authorKey);

    // ROLE FILTER
    let member = message.member;
    if (!member) {
      try {
        member = await message.guild.members.fetch(authorKey);
      } catch {
        return;
      }
    }

    const userRoleNames = member.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => r.name);

    const onlyAllowedRoles =
      userRoleNames.length > 0 &&
      userRoleNames.every((roleName) => ALLOWED_ROLES.includes(roleName));

    if (!onlyAllowedRoles) return;

    const userMsg = message.content.trim();
    const jumpLink = buildJumpLink(message);

    const { items } = await getRolimonsData();

    // ---------- STEP 1: Claude hint (not final truth) ----------
    const prompt = `
You will be given a Discord message from a Roblox trading server.

Your job:
1. Decide whether the message is clearly referring to a specific Roblox limited item.
2. If YES, output ONLY the name or acronym of that limited.
3. If NO, output exactly: UNKNOWN

Message: ${userMsg}
`;
    const aiResult = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 50,
      messages: [{ role: "user", content: prompt }],
    });
    const aiTextRaw = (aiResult.content?.[0]?.text || "").trim();
    const aiHint = aiTextRaw.replace(/^"|"$/g, "");

    if (!aiHint || aiHint.toUpperCase() === "UNKNOWN") {
      return;
    }

    // ---------- STEP 2: Correct Rolimons item match (scored) ----------
    const item = findBestItemMatch(items, userMsg, aiHint);
    if (!item) return;

    const itemId = item.id;
    const details = item.details;

    const name = details[0];
    const acronym = details[1];
    const rap = details[2];
    const value = details[3];

    const numericValue = Number(value) || 0;
    if (numericValue <= MIN_ITEM_VALUE) return;

    // ---------- STEP 3: 10s delay then re-check VERIFIED CACHE ----------
    await sleep(10000);

    // If they got logged during the delay, skip.
    if (cachedVerifiedKeys.has(authorKey)) return;

    // ---------- STEP 4: get thumbnail ----------
    const thumbnailUrl = await getItemThumbnail(itemId);

    // ---------- STEP 5: send webhook ----------
    const embed = {
      title: "High Value Item Mentioned",
      description:
        `**Message:** ${userMsg}\n` +
        `**Discord:** ${message.author.tag}\n` +
        `**Discord ID:** ${authorKey}\n` +
        `**Jump:** ${jumpLink}\n\n` +
        `**Item:** ${name}${acronym ? ` (${acronym})` : ""}\n` +
        `**Value:** ${formatValue(numericValue)}\n` +
        `**RAP:** ${formatValue(rap)}`,
      color: 0x00a2ff,
      timestamp: new Date().toISOString(),
    };

    if (thumbnailUrl) {
      embed.thumbnail = { url: thumbnailUrl };
    }

    await axios.post(WEBHOOK_URL, { embeds: [embed] });
  } catch (err) {
    console.error("[Monitor] Error processing message:", err?.message || err);
  }
});

client.on("error", (e) => console.error("Discord client error:", e));
process.on("unhandledRejection", (e) =>
  console.error("Unhandled promise rejection:", e)
);

process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});

client.login(TOKEN).catch((e) => {
  console.error("Failed to login:", e);
  process.exit(1);
});
