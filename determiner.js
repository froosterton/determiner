const { Client } = require('discord.js-selfbot-v13');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ----------------- CONFIG -----------------

const TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// channels to WATCH for people talking about items
const MONITOR_CHANNEL_IDS = [
  '430203025659789343',
  '442709792839172099',
  '442709710408515605'
];

// channel whose embeds contain Discord info for verified/logged users
const VERIFIED_CHANNEL_ID = '1403167119071248548';

// Rolimons API
const ROLIMONS_API = 'https://api.rolimons.com/items/v2/itemdetails';

// only log items with value strictly over this amount
const MIN_ITEM_VALUE = 100000; // 100K

// Role filter
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
// track users we've already *checked* once
const checkedUsers = new Set();

let itemsCache = null;
let lastItemsFetch = 0;
let acronymIndex = null;
let nameIndex = null;

// Discord user IDs we saw in VERIFIED_CHANNEL_ID
const verifiedUserIds = new Set();

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

function formatValue(value) {
  if (typeof value !== 'number') {
    value = Number(value);
    if (Number.isNaN(value)) return String(value);
  }
  if (value >= 1_000_000) return `${Math.round(value / 100000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

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
    console.error('[Thumbnail] Error:', err.message);
  }
  return null;
}

// pull Discord ID from embed (preferred)
function getDiscordIdFromEmbed(embed) {
  const regex = /discord id[:\s]*([0-9]{5,})/i;

  // try description first
  if (embed.description) {
    const m = embed.description.match(regex);
    if (m) return m[1].trim();
  }

  // then scan all fields (both name and value)
  if (embed.fields && embed.fields.length) {
    for (const field of embed.fields) {
      const text =
        (field.name ? String(field.name) + '\n' : '') +
        (field.value ? String(field.value) : '');
      const m = text.match(regex);
      if (m) return m[1].trim();
    }
  }

  return null;
}

// (backwards-compat only if you still have old entries with just "Discord:")
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

function addVerifiedFromMessage(message) {
  if (!message.embeds || !message.embeds.length) return;

  for (const embed of message.embeds) {
    // prefer ID
    const id = getDiscordIdFromEmbed(embed);
    if (id) {
      if (!verifiedUserIds.has(id)) {
        verifiedUserIds.add(id);
        console.log(`[Verified] Added ID ${id} from embed.`);
      }
      continue;
    }

    // if no ID present, you can optionally try to parse + skip,
    // but it will not map automatically to a user ID, so we just log.
    const discordName = getDiscordFromEmbed(embed);
    if (discordName) {
      console.log(
        `[Verified] Found old-style entry without ID (${discordName}), but not adding (ID-only mode).`
      );
    }
  }
}

// load up to 1000 messages from verification channel before monitoring
async function loadVerifiedUsers(maxMessages = 1000) {
  try {
    const channel = await client.channels.fetch(VERIFIED_CHANNEL_ID);
    if (!channel) {
      console.log('Could not fetch verified channel');
      return;
    }

    let fetched = 0;
    let lastId;

    while (fetched < maxMessages) {
      const limit = Math.min(100, maxMessages - fetched);
      const options = { limit };
      if (lastId) options.before = lastId;

      const batch = await channel.messages.fetch(options);
      if (batch.size === 0) break;

      batch.forEach((msg) => addVerifiedFromMessage(msg));
      fetched += batch.size;
      lastId = batch.last().id;
    }

    console.log(
      `[Verified] Loaded ${verifiedUserIds.size} user IDs from verification channel (scanned ${Math.min(
        maxMessages,
        fetched
      )} messages)`
    );
  } catch (err) {
    console.error('Error loading verified users:', err);
  }
}

function directTokenLookup(text, acronymIndex, nameIndex) {
  const tokens = tokenize(text).map((t) => normalize(t));

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

function messageSupportsItem(message, details) {
  const msgTokens = tokenize(message);
  const msgTokensNorm = msgTokens.map((t) => t.toLowerCase());

  const name = (details[0] || '').toLowerCase();
  const acronym = (details[1] || '').toLowerCase();
  const nameTokens = tokenize(name);

  if (acronym && msgTokensNorm.includes(acronym)) return true;

  for (const nTok of nameTokens) {
    for (const mTok of msgTokensNorm) {
      if (nTok === mTok) return true;
      if (mTok.length >= 3) {
        if (nTok.startsWith(mTok) || mTok.startsWith(nTok)) return true;
      }
    }
  }
  return false;
}

// small sleep helper for the 10s delay
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// build "jump to message" link
function buildJumpLink(message) {
  const guildId = message.guild ? message.guild.id : '@me';
  return `https://discord.com/channels/${guildId}/${message.channel.id}/${message.id}`;
}

// ------------- DISCORD EVENTS -------------

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  console.log(`[Monitor] Watching channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Checking embeds in: ${VERIFIED_CHANNEL_ID}`);
  await loadVerifiedUsers(1000);
});

client.on('messageCreate', async (message) => {
  try {
    // keep verifiedUserIds up to date
    if (message.channel.id === VERIFIED_CHANNEL_ID) {
      addVerifiedFromMessage(message);
      return;
    }

    // only monitor configured channels
    if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
    if (message.author.bot) return;
    if (!message.content || !message.content.trim()) return;
    if (!message.guild) return;

    const userMsg = message.content.trim();
    const jumpLink = buildJumpLink(message);
    const authorIdKey = message.author.id;

    // EARLY EXIT: if this Discord ID is already seen in verification channel,
    // do not even start processing
    if (verifiedUserIds.has(authorIdKey)) {
      console.log(
        `[Skip] ${message.author.tag} (ID ${authorIdKey}) is in verification channel; ignoring message.`
      );
      return;
    }

    // ROLE FILTER
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

    // do not double-process the same Discord message
    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);

    // do not check more than one message per user
    if (checkedUsers.has(message.author.id)) return;
    checkedUsers.add(message.author.id);

    console.log(`[Monitor] New message from ${message.author.tag}: ${userMsg}`);

    const { items, acronymIndex, nameIndex } = await getRolimonsData();

    // ---------- STEP 1: ask Gemini what item this is about ----------
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

    // ---------- STEP 2: map Gemini's key to a Rolimons item ----------
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
          `[Override] Using token-based match "${tokenItemFromMsg.details[0]}" instead of Gemini match "${
            item ? item.details[0] : 'none'
          }"`
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

    // -------- value threshold (>100k only) --------
    const numericValue = Number(value) || 0;
    if (numericValue <= MIN_ITEM_VALUE) {
      console.log(
        `[Skip] Item "${name}" value ${numericValue} <= MIN_ITEM_VALUE (${MIN_ITEM_VALUE})`
      );
      return;
    }

    // ---------- STEP 3: make sure item is clearly mentioned ----------
    if (!messageSupportsItem(userMsg, details)) {
      console.log(
        `[Skip] Item "${name}" not clearly mentioned in message: "${userMsg}"`
      );
      return;
    }

    console.log(
      `[Rolimons] Match: ${name} (${acronym}) | Value: ${numericValue} | RAP: ${rap}`
    );

    // ---------- STEP 3.5: wait 10 seconds, then re-check verification ----------
    await sleep(10000); // 10s delay

    if (verifiedUserIds.has(message.author.id)) {
      console.log(
        `[DelaySkip] ${message.author.tag} (ID ${message.author.id}) became verified during delay; not logging.`
      );
      return;
    }

    // ---------- STEP 4: get Roblox thumbnail ----------
    const thumbnailUrl = await getItemThumbnail(itemId);

    // ---------- STEP 5: send webhook ----------
    const embed = {
      title: 'High Value Item Mentioned',
      description:
        `**Message:** ${userMsg}\n` +
        `**Discord:** ${message.author.tag}\n` +
        `**Discord ID:** ${message.author.id}\n` +
        `**Jump:** ${jumpLink}\n\n` +
        `**Item:** ${name}${acronym ? ` (${acronym})` : ''}\n` +
        `**Value:** ${formatValue(numericValue)}`,
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
      const jumpLink = buildJumpLink(message);

      await axios.post(WEBHOOK_URL, {
        embeds: [
          {
            title: 'Error Processing Message',
            description:
              `**Message:** ${message.content}\n` +
              `**Discord:** ${
                message.author ? message.author.tag : 'Unknown'
              }\n` +
              `**Discord ID:** ${
                message.author ? message.author.id : 'Unknown'
              }\n` +
              `**Jump:** ${jumpLink}\n` +
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