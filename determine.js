const { Client } = require('discord.js-selfbot-v13');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ----------------- CONFIG -----------------

// MUST be set in Railway environment
const TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Hard-coded IDs are fine
const MONITOR_CHANNEL_ID = '442709792839172099';      // watch messages here
const VERIFIED_CHANNEL_ID = '1403167119071248548';    // embeds with "Discord: <name>"

// Rolimons API
const ROLIMONS_API = 'https://api.rolimons.com/items/v2/itemdetails';

// Role filter: user must have at least one role AND
// every role they have (other than @everyone) must be in this list.
const ALLOWED_ROLES = [
  'Verified',
  'Nitro Booster',
  '200k Members',
  'Game Night',
  'Weeb',
  'Art Talk',
  'Music',
  'Pets',
  "Rolimon's News Pings",
  'Content Pings',
  'Roblox News Pings',
  'Trading News Pings',
  'Limited Pings',
  'UGC Limited Pings',
  '-Free UGC Limited Pings',
  'Free UGC Limited Game Pings',
  'Upcoming UGC Limiteds Ping',
  'Free UGC Event Pings',
  'Poll Pings',
  'Value Change Pings',
  'Projection Pings'
];

// Fail fast if required env vars are missing
if (!TOKEN) {
  console.error('DISCORD_TOKEN is not set');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('WEBHOOK_URL is not set');
  process.exit(1);
}

// ----------------- GEMINI SETUP -----------------

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ----------------- DISCORD CLIENT -----------------

const client = new Client({ checkUpdate: false });
const processedMessages = new Set();

// Rolimons cache + indexes
let itemsCache = null;
let lastItemsFetch = 0;
let acronymIndex = null; // normAcronym -> { id, details }
let nameIndex = null;    // normName -> { id, details }

// Verified users set from embeds in VERIFIED_CHANNEL_ID
const verifiedUsers = new Set();

// ------------- HELPERS -------------

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(str) {
  return str.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function buildIndexes(items) {
  acronymIndex = new Map();
  nameIndex = new Map();

  for (const [id, details] of Object.entries(items)) {
    const name = details[0] || '';
    const acronym = details[1] || '';

    const normName = normalize(name);
    const normAcronym = normalize(acronym);

    if (normName) nameIndex.set(normName, { id, details });
    if (normAcronym) acronymIndex.set(normAcronym, { id, details });
  }
}

async function getRolimonsData() {
  const now = Date.now();

  if (itemsCache && now - lastItemsFetch < 10 * 60 * 1000) {
    return { items: itemsCache, acronymIndex, nameIndex };
  }

  const res = await axios.get(ROLIMONS_API);
  if (!res.data || !res.data.items) {
    throw new Error('Invalid Rolimons API response');
  }

  itemsCache = res.data.items;
  lastItemsFetch = now;
  buildIndexes(itemsCache);

  return { items: itemsCache, acronymIndex, nameIndex };
}

// shorten 480000 -> "480K"
function formatValue(value) {
  if (typeof value !== 'number') {
    value = Number(value);
    if (Number.isNaN(value)) return String(value);
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 100000) / 10}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`;
  }
  return String(value);
}

// Roblox thumbnails API for item image
async function getItemThumbnail(itemId) {
  try {
    const res = await axios.get('https://thumbnails.roblox.com/v1/assets', {
      params: {
        assetIds: itemId,
        size: '420x420',
        format: 'Png',
        isCircular: false
      }
    });

    const data = res.data;
    if (data && data.data && data.data[0] && data.data[0].imageUrl) {
      return data.data[0].imageUrl;
    }
  } catch (err) {
    console.error('[Thumbnail] Error fetching thumbnail:', err.message);
  }
  return null;
}

// Extract "Discord: <name>" from an embed
function getDiscordFromEmbed(embed) {
  if (embed.description) {
    const m = embed.description.match(/Discord:\s*([^\n\r]+)/i);
    if (m) return m[1].trim();
  }
  if (embed.fields && embed.fields.length) {
    for (const field of embed.fields) {
      if (!field.name) continue;
      if (field.name.toLowerCase().includes('discord') && field.value) {
        return field.value.trim();
      }
    }
  }
  return null;
}

// From a message in VERIFIED_CHANNEL_ID, add any Discord names found
function addVerifiedFromMessage(message) {
  if (!message.embeds || !message.embeds.length) return;
  for (const embed of message.embeds) {
    const discordName = getDiscordFromEmbed(embed);
    if (discordName) {
      const key = discordName.toLowerCase();
      if (!verifiedUsers.has(key)) {
        verifiedUsers.add(key);
        console.log(`[Verified] Added ${discordName}`);
      }
    }
  }
}

// Load recent verified users on startup (last 100 msgs for now)
async function loadVerifiedUsers() {
  try {
    const channel = await client.channels.fetch(VERIFIED_CHANNEL_ID);
    if (!channel) {
      console.log('Could not fetch verified channel');
      return;
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    messages.forEach((msg) => addVerifiedFromMessage(msg));

    console.log(
      `[Verified] Loaded ${verifiedUsers.size} users from verification channel`
    );
  } catch (err) {
    console.error('Error loading verified users:', err);
  }
}

// Direct lookup by tokens using Rolimons acronyms/names
function directTokenLookup(text, acronymIndex, nameIndex) {
  const tokens = tokenize(text).map((t) => normalize(t));

  // exact acronym first
  for (const token of tokens) {
    if (!token) continue;
    const hit = acronymIndex.get(token);
    if (hit) return hit;
  }

  const joined = normalize(text);
  const nameHit = nameIndex.get(joined);
  if (nameHit) return nameHit;

  return null;
}

// Fuzzy search when we have a guessed string from Gemini
function fuzzyFindByQuery(items, query) {
  const normQuery = normalize(query);
  if (!normQuery) return null;

  let bestMatch = null;
  let bestScore = -999;

  for (const [id, details] of Object.entries(items)) {
    const name = details[0] || '';
    const acronym = details[1] || '';

    const normName = normalize(name);
    const normAcronym = normalize(acronym);

    let score = 0;

    if (normAcronym === normQuery) score += 120;
    if (normAcronym && normAcronym.startsWith(normQuery)) score += 100;
    if (normAcronym && normQuery.includes(normAcronym)) score += 80;

    if (normName === normQuery) score += 90;
    if (normName.includes(normQuery)) score += 70;
    if (normQuery.includes(normName)) score += 50;

    if (normAcronym && normQuery[0] === normAcronym[0]) score += 10;
    if (normName && normQuery[0] === normName[0]) score += 5;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { id, details };
    }
  }

  if (bestScore < 50) return null;
  return bestMatch;
}

// Check that the resolved item is actually supported by words in the original message
function messageSupportsItem(message, details) {
  const msgTokens = tokenize(message);
  const msgTokensNorm = msgTokens.map((t) => t.toLowerCase());

  const name = (details[0] || '').toLowerCase();
  const acronym = (details[1] || '').toLowerCase();
  const nameTokens = tokenize(name);

  // 1) Message contains the exact acronym token (bv, stv, skotn, pic, etc.)
  if (acronym && msgTokensNorm.includes(acronym)) {
    return true;
  }

  // 2) Message shares a word or strong prefix with any name token
  for (const nTok of nameTokens) {
    for (const mTok of msgTokensNorm) {
      if (nTok === mTok) return true;

      if (mTok.length >= 3) {
        if (nTok.startsWith(mTok) || mTok.startsWith(nTok)) {
          return true;
        }
      }
    }
  }

  return false;
}

// ------------- DISCORD EVENTS -------------

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  console.log(`[Monitor] Watching channel: ${MONITOR_CHANNEL_ID}`);
  console.log(`[Monitor] Checking embeds in: ${VERIFIED_CHANNEL_ID}`);
  await loadVerifiedUsers();
});

client.on('messageCreate', async (message) => {
  try {
    // 1) Any new embed in verification channel updates verifiedUsers
    if (message.channel.id === VERIFIED_CHANNEL_ID) {
      addVerifiedFromMessage(message);
      return;
    }

    // 2) Only process messages in monitor channel for item talk
    if (message.channel.id !== MONITOR_CHANNEL_ID) return;
    if (message.author.bot) return;
    if (!message.content || !message.content.trim()) return;

    // --- ROLE FILTER ---
    if (!message.guild) return;

    let member = message.member;
    if (!member) {
      try {
        member = await message.guild.members.fetch(message.author.id);
      } catch {
        return;
      }
    }

    const userRoleNames = member.roles.cache
      .filter((r) => r.name !== '@everyone')
      .map((r) => r.name);

    const onlyAllowedRoles =
      userRoleNames.length > 0 &&
      userRoleNames.every((roleName) => ALLOWED_ROLES.includes(roleName));

    if (!onlyAllowedRoles) return;
    // --- end role filter ---

    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);

    const userMsg = message.content.trim();
    const authorNameKey = message.author.username.toLowerCase();

    // If this Discord name already appears in verified channel, skip
    if (verifiedUsers.has(authorNameKey)) {
      console.log(
        `[Skip] ${message.author.tag} already logged in verification channel`
      );
      return;
    }

    console.log(`[Monitor] New message from ${message.author.tag}: ${userMsg}`);

    const { items, acronymIndex, nameIndex } = await getRolimonsData();

    const prompt = `
You will be given a Discord message from a Roblox trading server.

Your job:
1. Decide whether the message is clearly referring to a specific Roblox limited item.
2. If YES, output ONLY the name or acronym of that limited.
3. If NO (for example, the message is about pictures, permissions, Discord, or something unrelated to a limited), output exactly: UNKNOWN

Examples (YOU MUST FOLLOW THESE):

"how much is valk getting"         -> Valkyrie Helm
"trading for ice valk"             -> Ice Valkyrie
"how much does prank get"          -> Prankster
"how much is skotn getting"        -> Silver King of the Night
"how much does stv get"            -> Sparkle Time Valkyrie
"is pv good?"                      -> Playful Vampire
"bv good or nah"                   -> Blackvalk
"what is chicken getting rn"       -> Telamon's Chicken Suit
"is dw good guys"                  -> Dog Whisperer
"dw good rn"                       -> Dog Whisperer
"is supa good rn"                  -> Supa Fly Cap

# Very important negative examples (should be UNKNOWN):
"how do i get pic perms"
"how do i send pics in here"
"can someone give me img perms"
"bro someone is trying to beam me"
"flipped is sub 2k lmao"
"your better off getting space hair or sta"
"i cant see the images"

Message: ${userMsg}
`;

    const aiResult = await model.generateContent(prompt);
    const aiTextRaw = aiResult.response.text().trim();
    const aiText = aiTextRaw.replace(/^"|"$/g, '');

    console.log(`[Gemini] Interpreted item key: "${aiText}"`);

    if (!aiText || aiText.toUpperCase() === 'UNKNOWN') {
      console.log(
        `[Skip] No limited detected in message: "${userMsg}" (Gemini UNKNOWN)`
      );
      return;
    }

    let item =
      directTokenLookup(aiText, acronymIndex, nameIndex) ||
      fuzzyFindByQuery(items, aiText);

    const tokenItemFromMsg = directTokenLookup(
      userMsg,
      acronymIndex,
      nameIndex
    );

    if (tokenItemFromMsg) {
      if (!item || tokenItemFromMsg.id !== item.id) {
        console.log(
          `[Override] Using token-based match "${tokenItemFromMsg.details[0]}" instead of Gemini match "${item ? item.details[0] : 'none'}"`
        );
        item = tokenItemFromMsg;
      }
    } else if (!item) {
      item = fuzzyFindByQuery(items, userMsg);
    }

    if (!item) {
      console.log(
        `[Skip] No Rolimons match for interpreted key "${aiText}" from message "${userMsg}"`
      );
      return;
    }

    const itemId = item.id;
    const details = item.details;

    const name = details[0];
    const acronym = details[1];
    const rap = details[2];
    const value = details[3];

    if (!messageSupportsItem(userMsg, details)) {
      console.log(
        `[Skip] Item "${name}" not clearly mentioned in message: "${userMsg}"`
      );
      return;
    }

    console.log(
      `[Rolimons] Match: ${name} (${acronym}) | Value: ${value} | RAP: ${rap}`
    );

    const thumbnailUrl = await getItemThumbnail(itemId);

    const embed = {
      title: 'High Value Item Mentioned',
      description:
        `**Message:** ${userMsg}\n` +
        `**Discord:** ${message.author.tag}\n\n` +
        `**Item:** ${name}${acronym ? ` (${acronym})` : ''}\n` +
        `**Value:** ${formatValue(value)}`,
      color: 0x00a2ff,
      timestamp: new Date().toISOString()
    };

    if (thumbnailUrl) {
      embed.thumbnail = { url: thumbnailUrl };
    }

    await axios.post(WEBHOOK_URL, { embeds: [embed] });
  } catch (err) {
    console.error('[Monitor] Error processing message:', err);

    try {
      await axios.post(WEBHOOK_URL, {
        embeds: [
          {
            title: 'Error Processing Message',
            description:
              `**Message:** ${message.content}\n` +
              `**Discord:** ${
                message.author ? message.author.tag : 'Unknown'
              }\n` +
              `**Error:** ${err.message}`,
            color: 0xff0000,
            timestamp: new Date().toISOString()
          }
        ]
      });
    } catch (webhookError) {
      console.error(
        '[Monitor] Error sending error webhook:',
        webhookError.message
      );
    }
  }
});

// ------------- STARTUP -------------

client.on('error', (e) => console.error('Discord client error:', e));
process.on('unhandledRejection', (e) =>
  console.error('Unhandled promise rejection:', e)
);
process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});

client.login(TOKEN).catch((e) => {
  console.error('Failed to login:', e);
  process.exit(1);
});
