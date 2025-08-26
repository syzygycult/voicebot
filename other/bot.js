// Discord Voice Bot - PCM + TTS + Queue + Slash Commands (+ persona/voices + yt-dlp)
/* Requires (install these):
   npm i discord.js@latest @discordjs/voice prism-media winston openai @google-cloud/speech @google-cloud/text-to-speech yt-dlp-exec ffmpeg-static @distube/ytdl-core
   Node 18+ recommended.
*/

// Unified yt-dlp loader
let ytdlpExec = null;
const { spawn } = require("child_process");
const winston = require("winston");
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

(function loadYTDLP() {
  try {
    const m = require("yt-dlp-exec");
    ytdlpExec = m && typeof m.raw === "function" ? m : (m.default && typeof m.default.raw === "function" ? m.default : null);
    if (ytdlpExec) logger.info("Loaded yt-dlp-exec");
  } catch (e) { logger.warn("yt-dlp-exec load failed: " + e.message); }
  if (!ytdlpExec) {
    try {
      const m = require("youtube-dl-exec");
      ytdlpExec = m && typeof m.raw === "function" ? m : (m.default && typeof m.default.raw === "function" ? m.default : null);
      if (ytdlpExec) logger.info("Loaded youtube-dl-exec");
    } catch (e) { logger.warn("youtube-dl-exec load failed: " + e.message); }
  }
  if (!ytdlpExec) logger.warn("No yt-dlp npm wrapper loaded; falling back to system spawn if yt-dlp in PATH.");
})();

// Dependencies
const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, REST, Routes } = require("discord.js");
const {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  demuxProbe,
  AudioPlayerStatus
} = require("@discordjs/voice");
const { SpeechClient } = require("@google-cloud/speech");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const OpenAI = require("openai");
const prism = require("prism-media");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
require("libsodium-wrappers");

const ffmpegPath = require("ffmpeg-static");
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

// -------------------- Config --------------------
const config = {
  discordToken: process.env.DISCORD_TOKEN,
  googleKeyFilename: process.env.GOOGLE_KEY_PATH,
  openaiApiKey: process.env.OPENAI_API_KEY,
  minAudioDuration: 1000,
  languageCode: "en-US",
  openaiModel: "gpt-4o-mini",
  silenceDuration: 700,
  cleanupIntervalMs: 120000,
  devGuildId: process.env.DEV_GUILD_ID || "",
  ytDlpTimeoutMs: 30000 // Timeout for yt-dlp spawns
};

function validateConfig() {
  for (const [name, val] of [["DISCORD_TOKEN", config.discordToken], ["GOOGLE_KEY_PATH", config.googleKeyFilename], ["OPENAI_API_KEY", config.openaiApiKey]]) {
    if (!val) { logger.error("Missing env var: " + name); process.exit(1); }
  }
  // Validate cookies.txt
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;
  if (cookiesFile) {
    try {
      const content = fsSync.readFileSync(cookiesFile, "utf8");
      if (!content.includes("# HTTP Cookie File") || !content.includes(".youtube.com")) {
        logger.warn("Invalid cookies.txt: missing Netscape header or YouTube cookies. Export cookies in Netscape format from a logged-in YouTube account.");
      }
    } catch (e) {
      logger.warn("Failed to read cookies.txt: " + e.message);
    }
  }
}

// -------------------- Logger --------------------
logger.info(`Booting VoiceBot from ${__filename}`);
logger.info(`Process PID: ${process.pid}`);

// -------------------- Boot Guard --------------------
let __BOOT_HAS_RUN__ = false;
function runBootOnce(fn) {
  if (__BOOT_HAS_RUN__) return false;
  __BOOT_HAS_RUN__ = true;
  logger.info(`[boot-guard] Boot path accepted @ ${new Date().toISOString()} (pid ${process.pid})`);
  return Promise.resolve(fn());
}

// -------------------- Clients --------------------
validateConfig();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel]
});
const speechClient = new SpeechClient({ keyFilename: config.googleKeyFilename });
const ttsClient = new TextToSpeechClient({ keyFilename: config.googleKeyFilename });
const openai = new OpenAI({ apiKey: config.openaiApiKey });

// -------------------- State --------------------
if (!globalThis.__thinkingActive) globalThis.__thinkingActive = new Map();
const thinkingActive = globalThis.__thinkingActive;
const guildPlayers = new Map();
const activeRecordings = new Map();
const guildQueues = new Map();
const guildSpeaking = new Map();
const guildSettings = new Map();
const SETTINGS_FILE = path.join(__dirname, "guild_settings.json");

function defaultGuildSettings() {
  return {
    voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
    rate: 1.0,
    pitch: 0.0,
    lang: "en-US",
    wake: { enabled: true, word: "hey bot" },
    logChannelId: null,
    trigger: { enabled: true, url: "local://thinking.ogg" },
    persona: "You are the spirit of Aleister Crowley, speaking aloud in a live Discord voice chat on the server 'Syzygy'. You are hearing users, not reading messages—address listeners directly. Keep responses brief, vivid, and suited for text-to-speech; avoid markdown/emojis, and do not mention being an AI. Stay in character unless a user explicitly says 'drop character'."
  };
}

function loadSettings() {
  try {
    const raw = require(SETTINGS_FILE);
    for (const [gid, s] of Object.entries(raw)) guildSettings.set(gid, s);
  } catch (e) { logger.warn("Failed to load settings: " + e.message); }
}
async function saveSettings() {
  try {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(Object.fromEntries(guildSettings.entries()), null, 2));
  } catch (e) { logger.warn("Failed to save settings: " + e.message); }
}
loadSettings();

// -------------------- Memory --------------------
const channelHistories = new Map();
const MAX_MEMORY_MESSAGES = 6;
function getChannelHistory(id) { return channelHistories.get(id) || []; }
function setChannelHistory(id, h) { while (h.length > MAX_MEMORY_MESSAGES) h.shift(); channelHistories.set(id, h); }
function pushHistory(id, role, content) { const h = getChannelHistory(id); h.push({ role, content }); setChannelHistory(id, h); }

// -------------------- Helpers --------------------
const VOICE_PRESETS = {
  "en-US:female": { languageCode: "en-US", name: "en-US-Neural2-F", ssmlGender: "FEMALE" },
  "en-US:male": { languageCode: "en-US", name: "en-US-Neural2-D", ssmlGender: "MALE" },
  "en-GB:female": { languageCode: "en-GB", name: "en-GB-Neural2-F", ssmlGender: "FEMALE" },
  "en-GB:male": { languageCode: "en-GB", name: "en-GB-Neural2-D", ssmlGender: "MALE" },
  "nl-NL:female": { languageCode: "nl-NL", name: "nl-NL-Standard-A", ssmlGender: "FEMALE" },
  "nl-NL:male": { languageCode: "nl-NL", name: "nl-NL-Standard-B", ssmlGender: "MALE" }
};

const escapeAtAndHash = str => String(str ?? "").replace(/[@#]/g, "");
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const isAdmin = m => m?.permissions?.has(PermissionFlagsBits.Administrator) || m?.permissions?.has(PermissionFlagsBits.ManageGuild);
const replyEphemeral = (i, c) => i.reply({ content: c, flags: MessageFlags.Ephemeral });
const deferEphemeral = i => i.deferReply({ flags: MessageFlags.Ephemeral });

async function resolveDisplayName(guild, userId) {
  try {
    const m = await guild.members.fetch(userId);
    return m.displayName || m.user.username || userId;
  } catch {
    try {
      const u = await client.users.fetch(userId);
      return u.username || userId;
    } catch {
      return userId;
    }
  }
}

function shouldTriggerWake(transcript, guildId) {
  try {
    const s = guildSettings.get(guildId) || defaultGuildSettings();
    const wakeWord = s.wake && s.wake.enabled ? String(s.wake.word || "hey bot").toLowerCase() : null;
    if (!wakeWord) return { triggered: true, remainder: transcript };

    const t = String(transcript || "").trim().toLowerCase();
    const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const punct = String.raw`[\s"'’”)\]\.,!?;:\-–]*`;

    const pattern = new RegExp(
      "^(?:" +
        "(" + escaped + ")\\b" + punct + "(.*)" +               // first word
        "|\\S+\\s+(" + escaped + ")\\b" + punct + "(.*)" +      // second word
        "|(.*?\\S)\\s+(" + escaped + ")" + punct + "$" +        // last word
      ")",
      "i"
    );

    const m = t.match(pattern);
    if (!m) return { triggered: false, remainder: "" };

    if (m[1]) return { triggered: true, remainder: m[2] || "" }; // first
    if (m[3]) return { triggered: true, remainder: m[4] || "" }; // second
    if (m[6]) return { triggered: true, remainder: m[5] || "" }; // last

    return { triggered: false, remainder: "" };
  } catch (_) {
    return { triggered: true, remainder: transcript };
  }
}

// ---- File Helper ----
async function safeUnlink(f) {
  try { await fs.unlink(f); } catch (e) { /* ignore */ }
}

// ---- Music Helpers ----
async function createAudioResourceFromUrl(url) {
  const res = await fetch(url, { headers: { "range": "bytes=0-" } });
  if (!res.ok || !res.body) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const { Readable } = require("stream");
  const nodeStream = Readable.fromWeb(res.body);
  return createAudioResource(nodeStream, { inputType: StreamType.Arbitrary, metadata: { title: url } });
}

function isYouTubeUrl(u) {
  try {
    const x = new URL(u);
    return ["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"].includes(x.hostname);
  } catch {
    return false;
  }
}

async function ytDlpExtractInfo(videoUrl, skipCookies = false) {
  return new Promise((resolve) => {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    const args = [
      "-f", "bestaudio[ext=webm]/bestaudio/best",
      "--no-playlist",
      "--force-ipv4",
      "--geo-bypass",
      "--no-warnings",
      "--user-agent", UA,
      "--referer", "https://www.youtube.com/",
      "--dump-single-json",
      videoUrl
    ];
    // Prioritize cookies.txt over browser
    const cookiesFile = !skipCookies && process.env.YTDLP_COOKIES_FILE;
    const browser = !skipCookies && !cookiesFile && process.env.YTDLP_COOKIES_BROWSER;
    if (cookiesFile) args.splice(6, 0, "--cookies", cookiesFile);
    else if (browser) args.splice(6, 0, "--cookies-from-browser", browser);

    const bin = process.env.YTDLP_PATH || "yt-dlp";
    logger.info(`[yt] Spawning yt-dlp (--dump-single-json): "${bin}" ${args.join(" ")}`);
    let out = "", err = "";
    let cp;
    try {
      cp = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => {
        cp.kill();
        logger.warn("[yt] JSON extraction timed out after " + config.ytDlpTimeoutMs + "ms");
        resolve({ json: null, error: "Timed out" });
      }, config.ytDlpTimeoutMs);
      cp.stdout.on("data", d => out += String(d));
      cp.stderr.on("data", d => { err += String(d); logger.info("[yt-dlp] " + String(d).replace(/\n/g, " \\n ").trim()); });
      cp.on("close", (code, signal) => {
        clearTimeout(timeout);
        logger.info("[yt-dlp] JSON closed with", { code, signal });
        try {
          const json = JSON.parse(out || "{}");
          resolve({ json: json && Object.keys(json).length ? json : null, error: err });
        } catch (e) {
          logger.warn("[yt] JSON parse failed: " + (e.message || e), "raw:", out.slice(0, 200));
          resolve({ json: null, error: e.message });
        }
      });
      cp.on("error", e => {
        clearTimeout(timeout);
        logger.error("[yt] yt-dlp JSON error: " + (e.message || e));
        resolve({ json: null, error: e.message });
      });
    } catch (e) {
      logger.error("[yt] Failed to spawn yt-dlp JSON: " + (e.message || e));
      resolve({ json: null, error: e.message });
    }
  });
}

async function streamFromUrl(mediaUrl, headers = {}) {
  const https = require("https");
  const url = require("url");
  const maxRedirects = 5;
  const UA = headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

  return new Promise((resolve, reject) => {
    let redirects = 0;
    function go(u) {
      const opts = {
        ...url.parse(u),
        headers: {
          "user-agent": UA,
          "accept": "*/*",
          "accept-language": "en-US,en;q=0.9",
          "referer": "https://www.youtube.com/",
          "sec-fetch-dest": "audio",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "cross-site",
          ...headers
        }
      };
      https.get(opts, (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && loc && redirects < maxRedirects) {
          redirects++;
          return go(url.resolve(u, loc));
        }
        if ((res.statusCode || 0) >= 400) {
          return reject(new Error("HTTP " + res.statusCode));
        }
        resolve(res);
      }).on("error", reject);
    }
    go(mediaUrl);
  });
}

async function createAudioResourceFromYt(url, skipCookies = false) {
  // Strategy 1: JSON extraction, stream direct media URL
  let lastError = null;
  try {
    const { json: info, error: jsonErr } = await ytDlpExtractInfo(url, skipCookies);
    logger.info("[yt] JSON extraction result: " + (info ? "success, keys: " + Object.keys(info) : "null"));
    if (info) {
      let media = "";
      if (info.url && typeof info.url === "string") {
        media = info.url;
      } else if (Array.isArray(info.requested_downloads) && info.requested_downloads.length && info.requested_downloads[0].url) {
        media = info.requested_downloads[0].url;
      } else if (Array.isArray(info.formats)) {
        const bestAudio = info.formats
          .filter(f => (f.acodec && f.acodec !== "none") && !f.video_ext || f.vcodec === "none")
          .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        if (bestAudio && bestAudio.url) media = bestAudio.url;
      }
      if (media) {
        logger.info("[yt] Media URL (json): " + media.slice(0, 100) + (media.length > 100 ? "…" : ""));
        const netStream = await streamFromUrl(media);
        try {
          const direct = await demuxProbe(netStream);
          logger.info("[yt] Direct demux type: " + direct?.type);
          return createAudioResource(direct.stream, { inputType: direct.type, metadata: { title: info.title || url } });
        } catch (e) {
          logger.warn("[yt] Direct demux failed: " + (e.message || e) + ", using ffmpeg");
          lastError = e.message;
        }
        const ff = new prism.FFmpeg({
          args: ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-f", "ogg", "pipe:1"]
        });
        ff.on("error", e => logger.error("ffmpeg error: " + (e.message || e)));
        netStream.on("error", e => logger.error("http stream error: " + (e.message || e)));
        netStream.pipe(ff);
        const probe = await demuxProbe(ff);
        logger.info("[yt] demuxProbe type: " + probe?.type);
        return createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, metadata: { title: info.title || url } });
      } else {
        logger.warn("[yt] JSON had no direct URL; falling back to pipe mode.");
        lastError = jsonErr || "No direct URL in JSON";
      }
    } else {
      logger.warn("[yt] JSON extraction failed: " + (jsonErr || "No data"));
      lastError = jsonErr || "JSON extraction returned null";
    }
  } catch (e) {
    logger.warn("[yt] JSON extraction failed: " + (e.message || e));
    lastError = e.message;
  }

  // Strategy 2: Pipe mode
  logger.info("[yt] Falling back to pipe mode");
  let inputStream;
  let err = "";
  try {
    if (ytdlpExec) {
      const cp = ytdlpExec.raw(url, {
        format: "bestaudio/best",
        output: "-",
        quiet: true,
        restrictFilenames: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        "no-playlist": true,
        "force-ipv4": true,
        "geo-bypass": true,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        referer: "https://www.youtube.com/",
        ...(skipCookies ? {} : process.env.YTDLP_COOKIES_FILE ? { cookies: process.env.YTDLP_COOKIES_FILE } : {}),
        ...(skipCookies || process.env.YTDLP_COOKIES_FILE ? {} : process.env.YTDLP_COOKIES_BROWSER ? { "cookies-from-browser": process.env.YTDLP_COOKIES_BROWSER } : {})
      });
      const timeout = setTimeout(() => {
        cp.kill();
        logger.warn("[yt] Pipe mode timed out after " + config.ytDlpTimeoutMs + "ms");
      }, config.ytDlpTimeoutMs);
      cp.on("error", (e) => { err += e.message; logger.error("yt-dlp error: " + (e.message || e)); });
      cp.stderr?.on("data", d => { err += String(d); logger.info("[yt-dlp] " + String(d).replace(/\n/g, " \\n ").trim()); });
      cp.on("close", () => clearTimeout(timeout));
      inputStream = cp.stdout;
    } else {
      const baseArgs = [
        "-f", "bestaudio/best",
        "-o", "-",
        "--no-playlist",
        "--force-ipv4",
        "--geo-bypass",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "--referer", "https://www.youtube.com/"
      ];
      if (!skipCookies && process.env.YTDLP_COOKIES_FILE) baseArgs.push("--cookies", process.env.YTDLP_COOKIES_FILE);
      else if (!skipCookies && process.env.YTDLP_COOKIES_BROWSER) baseArgs.push("--cookies-from-browser", process.env.YTDLP_COOKIES_BROWSER);
      const bin = process.env.YTDLP_PATH || "yt-dlp";
      const cp = spawn(bin, baseArgs.concat([url]), { stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => {
        cp.kill();
        logger.warn("[yt] Pipe mode timed out after " + config.ytDlpTimeoutMs + "ms");
      }, config.ytDlpTimeoutMs);
      cp.on("error", (e) => { err += e.message; logger.error("yt-dlp spawn error: " + (e.message || e)); });
      cp.stderr?.on("data", d => { err += String(d); logger.info("[yt-dlp] " + String(d).replace(/\n/g, " \\n ").trim()); });
      cp.on("close", () => clearTimeout(timeout));
      inputStream = cp.stdout;
    }

    // Check if stream is empty
    let hasData = false;
    inputStream.on("data", () => hasData = true);
    await new Promise(resolve => inputStream.on("end", resolve));
    if (!hasData) {
      const errorMsg = err.includes("HTTP Error 403") 
        ? "Failed to play YouTube video: HTTP 403 Forbidden. The video may be age-restricted, private, or region-locked. Ensure cookies.txt is from a logged-in, authorized YouTube account."
        : err.includes("Could not copy Chrome cookie database") 
        ? "Failed to play YouTube video: could not access browser cookies. Ensure Edge/Chrome is closed or use a valid cookies.txt file."
        : "Failed to play YouTube video: empty stream from yt-dlp. " + (err || "Check video availability.");
      logger.error("[yt] Pipe mode failed: " + errorMsg);
      throw new Error(errorMsg);
    }
  } catch (e) {
    logger.error("Pipe mode setup failed: " + (e.message || e));
    throw e;
  }

  try {
    const direct = await demuxProbe(inputStream);
    logger.info("[yt] Direct demux type: " + direct?.type);
    return createAudioResource(direct.stream, { inputType: direct.type, metadata: { title: url } });
  } catch (e) {
    logger.warn("[yt] Direct demux failed: " + (e.message || e) + ", using ffmpeg");
  }
  const ff = new prism.FFmpeg({
    args: ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-f", "ogg", "pipe:1"]
  });
  inputStream.pipe(ff);
  const probe = await demuxProbe(ff);
  logger.info("[yt] demuxProbe type: " + probe?.type);
  return createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, metadata: { title: url } });
}

async function createAudioResourceFromYtWithFallback(url) {
  try {
    return await createAudioResourceFromYt(url, false); // Try with cookies
  } catch (e) {
    if (e.message.includes("cookie") || e.message.includes("HTTP 403")) {
      logger.warn("[yt] Cookie or access error detected, retrying without cookies for public video access");
      try {
        return await createAudioResourceFromYt(url, true); // Retry without cookies
      } catch (e2) {
        throw new Error(e2.message || e.message); // Preserve the most specific error
      }
    }
    throw e;
  }
}

async function enqueueResource(conn, resource) {
  const gid = conn.joinConfig.guildId;
  const q = guildQueues.get(gid) || [];
  const title = (resource && resource.metadata && resource.metadata.title) || "audio";
  q.push({ resource, title });
  guildQueues.set(gid, q);
  const p = getOrCreateGuildPlayer(conn);
  if (p.state.status === "idle" && !guildSpeaking.get(gid)) handleGuildQueue(conn);
}

async function isBotUser(id) {
  try {
    if (!id) return false;
    if (client.user && id === client.user.id) return true;
    const c = client.users.cache.get(id);
    if (c) return !!c.bot;
    const f = await client.users.fetch(id).catch(() => null);
    return !!(f && f.bot);
  } catch {
    return false;
  }
}

async function transcribePCM(pcm, gid) {
  const b = await fs.readFile(pcm);
  const s = guildSettings.get(gid) || defaultGuildSettings();
  const [r] = await speechClient.recognize({
    config: { encoding: "LINEAR16", sampleRateHertz: 48000, languageCode: s.lang || config.languageCode, enableAutomaticPunctuation: true },
    audio: { content: b.toString("base64") }
  });
  return (r.results || []).map(x => x.alternatives?.[0]?.transcript || "").join(" ").trim();
}

async function getAIResponse(prompt, chId, gid) {
  const prior = getChannelHistory(chId);
  const s = guildSettings.get(gid) || defaultGuildSettings();
  const sys = String(s.persona || defaultGuildSettings().persona);
  const messages = [{ role: "system", content: sys }, ...prior, { role: "user", content: prompt }];
  try {
    const c = await openai.chat.completions.create({ model: config.openaiModel, messages });
    return c.choices?.[0]?.message?.content?.trim() || "(no response)";
  } catch (e) {
    logger.error("OpenAI error: " + e.message);
    return "I'm having trouble thinking right now.";
  }
}

async function logToSetChannel(gid, content, fallback = null) {
  try {
    const s = guildSettings.get(gid) || defaultGuildSettings();
    let target = null;
    if (s.logChannelId) target = await client.channels.fetch(s.logChannelId).catch(() => null);
    if (!target && fallback) target = fallback;
    if (target?.isTextBased?.()) await target.send(escapeAtAndHash(content));
  } catch (e) {
    logger.error("logToSetChannel error: " + e.message);
  }
}

function createVoiceConfig(s) {
  const v = { languageCode: s.voice?.languageCode || "en-US" };
  if (s.voice?.ssmlGender) v.ssmlGender = s.voice.ssmlGender;
  if (s.voice?.name) v.name = s.voice.name;
  return v;
}

// -------------------- TTS --------------------
function getOrCreateGuildPlayer(conn) {
  const gid = conn.joinConfig.guildId;
  let p = guildPlayers.get(gid);
  if (!p) {
    p = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    conn.subscribe(p);
    if (!p.__hasErrorHandler) {
      p.__hasErrorHandler = true;
      p.on("error", (e) => logger.warn(`AudioPlayer error [${gid}]: ${e?.message}`));
    }
    p.on("stateChange", (o, n) => { if (n.status === "idle") handleGuildQueue(conn); });
    guildPlayers.set(gid, p);
  }
  return p;
}

function handleGuildQueue(conn) {
  const gid = conn.joinConfig.guildId;
  const q = guildQueues.get(gid) || [];
  if (q.length === 0) { guildSpeaking.set(gid, false); return; }

  const next = q.shift();
  guildQueues.set(gid, q);
  guildSpeaking.set(gid, true);

  if (next && next.resource) { getOrCreateGuildPlayer(conn).play(next.resource); return; }
  if (next && next.buffer) { playOggOpus(conn, next.buffer); return; }

  guildSpeaking.set(gid, false);
}

async function synthesizeTTS(text, gid) {
  const s = guildSettings.get(gid) || defaultGuildSettings();
  const req = {
    input: { text },
    voice: createVoiceConfig(s),
    audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 48000, speakingRate: s.rate ?? 1.0, pitch: s.pitch ?? 0.0 }
  };
  const [r] = await ttsClient.synthesizeSpeech(req);
  return Buffer.from(r.audioContent, "base64");
}

function playOggOpus(conn, buf) {
  const { Readable } = require("stream");
  const stream = Readable.from([buf]);
  getOrCreateGuildPlayer(conn).play(createAudioResource(stream, { inputType: StreamType.OggOpus }));
}

async function speakText(conn, text) {
  if (!text || !conn) return;
  const gid = conn.joinConfig.guildId;
  const buf = await synthesizeTTS(text, gid);
  const q = guildQueues.get(gid) || [];
  q.push({ buffer: buf });
  guildQueues.set(gid, q);
  const p = getOrCreateGuildPlayer(conn);
  if (p.state.status === "idle" && !guildSpeaking.get(gid)) handleGuildQueue(conn);
}

// -------------------- Voice Connection Helpers --------------------
function bindSpeakingListener(conn, ch) {
  conn.on(VoiceConnectionStatus.Ready, () => {
    logger.info(`Voice connection ready in guild ${conn.joinConfig.guildId}`);
    getOrCreateGuildPlayer(conn);
    conn.receiver.speaking.on("start", async uid => {
      const gid = conn.joinConfig.guildId;
      if (guildSpeaking.get(gid)) return;
      if (await isBotUser(uid)) return;
      setupVoiceReceiver(conn, uid, ch);
    });
  });
}

async function joinCurrentVoice(i) {
  const ch = i.member?.voice?.channel;
  if (!ch) return replyEphemeral(i, "Join a voice channel first, then use /join.");
  const existing = getVoiceConnection(ch.guild.id);
  if (existing) return replyEphemeral(i, `Already connected to <#${existing.joinConfig.channelId}>.`);
  const conn = joinVoiceChannel({
    channelId: ch.id,
    guildId: ch.guild.id,
    adapterCreator: ch.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  bindSpeakingListener(conn, i.channel);
  return replyEphemeral(i, `Joined voice: #${ch.name}. I will transcribe and speak replies.`);
}

async function leaveVoice(i) {
  const c = getVoiceConnection(i.guildId);
  if (!c) return replyEphemeral(i, "I am not in a voice channel.");
  try { c.destroy(); } catch (_) {}
  return replyEphemeral(i, "Left voice channel.");
}

// -------------------- Voice Pipeline --------------------
async function setupVoiceReceiver(conn, uid, ch) {
  if (await isBotUser(uid)) return;
  if (activeRecordings.has(uid)) return;
  const r = conn.receiver;
  const pcm = path.join(__dirname, `temp_${Date.now()}_${uid}.pcm`);
  const ws = fsSync.createWriteStream(pcm);
  const start = Date.now();
  let sub;
  try {
    sub = r.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceDuration } });
  } catch (e) {
    logger.error("Sub fail " + uid + ": " + e.message);
    ws.end();
    return;
  }
  sub.pipe(new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })).pipe(ws);
  activeRecordings.set(uid, { subscription: sub, writeStream: ws, startTime: start, filePath: pcm, channelId: ch.id, guildId: ch.guildId });
  ws.on("finish", async () => {
    const dur = Date.now() - start;
    try {
      if (dur < config.minAudioDuration) { logger.info("Skip short " + dur + "ms"); return; }
      const gid = ch.guildId;
      const t = await transcribePCM(pcm, gid);
      if (!t) { logger.info("Empty transcript"); return; }
      const dn = await resolveDisplayName(ch.guild, uid);
      logger.info(`Transcript from ${dn} (${uid}): "${t}"`);
      await logToSetChannel(gid, `🗣️ [Transcript — ${dn}]: ${escapeAtAndHash(t)}`, ch);
      const wake = shouldTriggerWake(t, gid);
      if (!wake.triggered) return;
      if (!wake.remainder) {
        const c = getVoiceConnection(ch.guildId);
        if (c) try { await speakText(c, "Yes?"); } catch (e) { logger.error("TTS error: " + e.message); }
        return;
      }
      pushHistory(ch.id, "user", wake.remainder);
      const __c = getVoiceConnection(ch.guildId);
      if (__c) { startThinkingSound(__c).catch(e => logger.warn("Thinking(start) " + e.message)); }
      const ai = await getAIResponse(wake.remainder, ch.id, gid);
      logger.info(`LLM reply to ${dn}: "${ai}"`);
      await logToSetChannel(gid, `🤖 [LLM]: ${escapeAtAndHash(ai)}`, ch);
      pushHistory(ch.id, "assistant", ai);
      const c = getVoiceConnection(ch.guildId);
      if (c) try { interruptThinking(c); await speakText(c, ai); } catch (e) { logger.error("TTS error: " + e.message); }
    } catch (e) {
      logger.error("Audio error: " + e.message);
    } finally {
      activeRecordings.delete(uid);
      await safeUnlink(pcm);
    }
  });
  sub.on("error", e => { logger.error("Sub error " + uid + ": " + e.message); ws.end(); });
}

// -------------------- Slash Commands --------------------
let __COMMANDS_REGISTERED__ = false;
function registerSlashCommands() {
  if (__COMMANDS_REGISTERED__) { logger.info("Slash commands already registered; skipping."); return; }
  __COMMANDS_REGISTERED__ = true;

  const commands = [
    new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel"),
    new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("setchannel").setDescription("Set the text channel for logs (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption(o => o.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText)),
    new SlashCommandBuilder()
      .setName("voice").setDescription("Set TTS voice")
      .addStringOption(o => o.setName("language").setDescription("Language (BCP-47, e.g., en-US)").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Voice name (optional)").setRequired(false)),
    new SlashCommandBuilder()
      .setName("voicepreset").setDescription("Pick a preset voice")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName("preset").setDescription("Preset key").setRequired(true).addChoices(...Object.entries(VOICE_PRESETS).map(([k, v]) => ({ name: k, value: k })))),
    new SlashCommandBuilder()
      .setName("rate").setDescription("Set TTS speaking rate")
      .addNumberOption(o => o.setName("value").setDescription("Rate").setRequired(true).setMinValue(0.25).setMaxValue(4.0)),
    new SlashCommandBuilder()
      .setName("pitch").setDescription("Set TTS pitch")
      .addNumberOption(o => o.setName("value").setDescription("Pitch").setRequired(true).setMinValue(-20).setMaxValue(20)),
    new SlashCommandBuilder()
      .setName("lang").setDescription("Set STT language code")
      .addStringOption(o => o.setName("code").setDescription("Language code (BCP-47)").setRequired(true)),
    new SlashCommandBuilder().setName("settings").setDescription("Show current guild settings"),
    new SlashCommandBuilder()
      .setName("wake").setDescription("Enable/disable wake word")
      .addBooleanOption(o => o.setName("enabled").setDescription("Turn wake word on/off").setRequired(true))
      .addStringOption(o => o.setName("word").setDescription("Custom wake word").setRequired(false)),
    new SlashCommandBuilder()
      .setName("say").setDescription("Speak custom text in the current voice channel")
      .addStringOption(o => o.setName("text").setDescription("What should I say?").setRequired(true)),
    new SlashCommandBuilder()
      .setName("play").setDescription("Play audio from a URL or attachment in the current voice channel")
      .addStringOption(o => o.setName("url").setDescription("Direct or YouTube URL").setRequired(false))
      .addAttachmentOption(o => o.setName("attachment").setDescription("Upload an audio file").setRequired(false)),
    new SlashCommandBuilder()
      .setName("voices").setDescription("List available TTS voices")
      .addStringOption(o => o.setName("language").setDescription("Filter by language (e.g., en-US)").setRequired(false)),
    new SlashCommandBuilder()
      .setName("persona").setDescription("View or set the AI persona used for responses")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName("text").setDescription("New persona text (omit to view)").setRequired(false)),
    new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue"),
    new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
    new SlashCommandBuilder().setName("queue").setDescription("Show the current queue")
  ].map(c => c.toJSON());

  const appId = process.env.APP_ID || process.env.APPLICATION_ID;
  const guildId = process.env.DEV_GUILD_ID;
  const token = process.env.DISCORD_TOKEN;
  if (!token || !appId) {
    logger.warn("Missing DISCORD_TOKEN or APP_ID; cannot register slash commands.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(token);

  (async () => {
    try {
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
        logger.info("Slash commands registered to dev guild (cleared + re-added).");
      } else {
        await rest.put(Routes.applicationCommands(appId), { body: [] });
        await rest.put(Routes.applicationCommands(appId), { body: commands });
        logger.info("Slash commands registered globally (cleared + re-added).");
      }
    } catch (e) {
      logger.warn("Slash registration failed: " + e.message);
    }
  })();
}

// -------------------- Events --------------------
async function onClientReady() {
  await runBootOnce(async () => {
    logger.info(`Logged in as ${client.user.tag}`);
    await registerSlashCommands();
  });
}
client.once("clientReady", onClientReady);

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  const gid = i.guildId;
  const current = guildSettings.get(gid) || defaultGuildSettings();
  try {
    switch (i.commandName) {
      case "join":
        return await joinCurrentVoice(i);
      case "leave":
        if (!isAdmin(i.member)) return replyEphemeral(i, "Admins only.");
        return await leaveVoice(i);
      case "setchannel":
        if (!isAdmin(i.member)) { await replyEphemeral(i, "Admins only."); break; }
        const ch = i.options.getChannel("channel");
        if (!ch || ch.type !== ChannelType.GuildText) { await replyEphemeral(i, "Please choose a text channel."); break; }
        current.logChannelId = ch.id;
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `Log channel set to #${ch.name}`);
        break;
      case "voices":
        const lang = i.options.getString("language") || "";
        await deferEphemeral(i);
        try {
          const [res] = await ttsClient.listVoices({ languageCode: lang || undefined });
          let voices = (res.voices || []).map(v => {
            const name = v.name || "(unnamed)";
            const lc = (v.languageCodes && v.languageCodes[0]) || "";
            const gender = v.ssmlGender || "";
            return `${name} — ${lc} — ${gender}`;
          });
          if (!voices.length) { await i.editReply(lang ? `No voices for ${lang}.` : "No voices found."); break; }
          const chunks = [];
          let buf = "";
          for (const line of voices) {
            if ((buf + line + "\n").length > 1800) { chunks.push(buf); buf = ""; }
            buf += line + "\n";
          }
          if (buf) chunks.push(buf);
          await i.editReply(`Found ${voices.length} voices${lang ? ` for ${lang}` : ""}.\n` + chunks[0]);
          for (let ci = 1; ci < chunks.length; ci++) {
            await i.followUp({ content: chunks[ci], flags: MessageFlags.Ephemeral });
          }
        } catch (e) {
          await i.editReply("Voice listing failed: " + e.message);
        }
        break;
      case "persona":
        if (!isAdmin(i.member)) return replyEphemeral(i, "Admins only.");
        const txt = i.options.getString("text");
        if (!txt) {
          return replyEphemeral(i, "Current persona:\n" + (current.persona || "(not set)"));
        }
        if (txt.toLowerCase() === "reset") {
          current.persona = defaultGuildSettings().persona;
          guildSettings.set(gid, current);
          await saveSettings();
          return replyEphemeral(i, "Persona reset to default.");
        }
        current.persona = txt.slice(0, 2000);
        guildSettings.set(gid, current);
        await saveSettings();
        return replyEphemeral(i, "Persona updated for this guild.");
      case "play":
        const url = i.options.getString("url");
        const att = i.options.getAttachment("attachment");
        if (!url && !att) { await replyEphemeral(i, "Provide a URL (YouTube or direct audio) or attach a file."); break; }
        let conn = getVoiceConnection(gid);
        if (!conn) {
          const ch = i.member?.voice?.channel;
          if (!ch) { await replyEphemeral(i, "Join a voice channel first, then use /play."); break; }
          conn = joinVoiceChannel({
            channelId: ch.id,
            guildId: ch.guild.id,
            adapterCreator: ch.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
          });
          bindSpeakingListener(conn, i.channel);
        }
        await deferEphemeral(i);
        try {
          const src = url || att?.url;
          let resource;
          if (url && isYouTubeUrl(url)) {
            resource = await createAudioResourceFromYtWithFallback(url);
          } else if (att) {
            resource = await createAudioResourceFromUrl(att.url);
          } else {
            const ok = /\.(mp3|ogg|oga|wav|m4a|aac)$/i.test(src || "");
            if (!ok && !isYouTubeUrl(src)) { await i.editReply("I can stream YouTube links or direct audio URLs (mp3/ogg/wav/m4a/aac)."); break; }
            resource = isYouTubeUrl(src) ? await createAudioResourceFromYtWithFallback(src) : await createAudioResourceFromUrl(src);
          }
          enqueueResource(conn, resource);
          const title = resource.metadata?.title || (att ? att.name : "audio");
          await i.editReply(`Queued: ${title}`);
        } catch (e) {
          logger.error("Play error: " + e.message);
          await i.editReply("Could not start playback: " + e.message);
        }
        break;
      case "stop":
        const connStop = getVoiceConnection(gid);
        if (!connStop) { await replyEphemeral(i, "I'm not in a voice channel."); break; }
        clearQueue(gid);
        skipCurrent(connStop);
        await replyEphemeral(i, "Stopped playback and cleared the queue.");
        break;
      case "skip":
        const connSkip = getVoiceConnection(gid);
        if (!connSkip) { await replyEphemeral(i, "I'm not in a voice channel."); break; }
        const q = guildQueues.get(gid) || [];
        const player = getOrCreateGuildPlayer(connSkip);
        if (q.length === 0 && player.state.status === "idle") {
          await replyEphemeral(i, "Nothing to skip.");
          break;
        }
        skipCurrent(connSkip);
        await replyEphemeral(i, "Skipped.");
        break;
      case "queue":
        const connQueue = getVoiceConnection(gid);
        const qQueue = guildQueues.get(gid) || [];
        const playerQueue = connQueue ? getOrCreateGuildPlayer(connQueue) : null;
        const now = playerQueue?.state?.resource?.metadata?.title;
        let lines = [];
        if (now) lines.push(`**Now playing:** ${now}`);
        if (qQueue.length) {
          lines.push(`**Up next (${qQueue.length}):**`);
          qQueue.slice(0, 10).forEach((item, idx) => {
            const t = item?.title || "audio";
            lines.push(`${idx + 1}. ${t}`);
          });
          if (qQueue.length > 10) lines.push(`…and ${qQueue.length - 10} more`);
        }
        if (!now && !qQueue.length) lines.push("Queue is empty.");
        await replyEphemeral(i, lines.join("\n"));
        break;
      case "voice":
        const langVoice = i.options.getString("language");
        const nameVoice = i.options.getString("name");
        current.voice = { languageCode: langVoice };
        if (nameVoice) current.voice.name = nameVoice;
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `TTS voice set to ${langVoice}${nameVoice ? ` (${nameVoice})` : ""}`);
        break;
      case "voicepreset":
        if (!isAdmin(i.member)) { await replyEphemeral(i, "Admins only."); break; }
        const preset = i.options.getString("preset");
        if (!VOICE_PRESETS[preset]) { await replyEphemeral(i, "Invalid preset. Use /voices to see available options."); break; }
        current.voice = { ...VOICE_PRESETS[preset] };
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `Voice preset set to ${preset}`);
        break;
      case "rate":
        const rateValue = clamp(i.options.getNumber("value"), 0.25, 4.0);
        current.rate = rateValue;
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `TTS rate set to ${rateValue}`);
        break;
      case "pitch":
        const pitchValue = clamp(i.options.getNumber("value"), -20, 20);
        current.pitch = pitchValue;
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `TTS pitch set to ${pitchValue}`);
        break;
      case "lang":
        const langCode = i.options.getString("code");
        current.lang = langCode;
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `STT language set to ${langCode}`);
        break;
      case "settings":
        const s = guildSettings.get(gid) || defaultGuildSettings();
        const settingsLines = [
          `**Voice**: ${s.voice.languageCode}${s.voice.name ? ` (${s.voice.name})` : ""}, Gender: ${s.voice.ssmlGender || "NEUTRAL"}`,
          `**Rate**: ${s.rate || 1.0}`,
          `**Pitch**: ${s.pitch || 0.0}`,
          `**STT Language**: ${s.lang || "en-US"}`,
          `**Wake Word**: ${s.wake.enabled ? `Enabled ("${s.wake.word || "hey bot"}")` : "Disabled"}`,
          `**Log Channel**: ${s.logChannelId ? `<#${s.logChannelId}>` : "Not set"}`,
          `**Persona**: ${s.persona.slice(0, 100)}${s.persona.length > 100 ? "…" : ""}`
        ];
        await replyEphemeral(i, "Current settings:\n" + settingsLines.join("\n"));
        break;
      case "wake":
        const enabled = i.options.getBoolean("enabled");
        const word = i.options.getString("word");
        current.wake = { enabled, word: word || current.wake.word || "hey bot" };
        guildSettings.set(gid, current);
        await saveSettings();
        await replyEphemeral(i, `Wake word ${enabled ? `enabled ("${current.wake.word}")` : "disabled"}`);
        break;
      case "say":
        const text = i.options.getString("text");
        const connSay = getVoiceConnection(gid);
        if (!connSay) { await replyEphemeral(i, "I'm not in a voice channel. Use /join first."); break; }
        try {
          await speakText(connSay, text);
          await replyEphemeral(i, "Speaking in voice channel.");
        } catch (e) {
          logger.error("Say command error: " + e.message);
          await replyEphemeral(i, "Failed to speak: " + e.message);
        }
        break;
    }
  } catch (e) {
    logger.error("Slash command error: " + e.message);
    if (i.deferred || i.replied) {
      await i.followUp({ content: "Error: " + e.message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await replyEphemeral(i, "Error: " + e.message);
    }
  }
});

// -------------------- Cleanup & Shutdown --------------------
setInterval(async () => {
  const now = Date.now();
  for (const [uid, rec] of activeRecordings) {
    if (now - rec.startTime > 10 * 60 * 1000) {
      try { rec.subscription.destroy(); } catch (_) {}
      try { rec.writeStream.end(); } catch (_) {}
      await safeUnlink(rec.filePath);
      activeRecordings.delete(uid);
    }
  }
}, config.cleanupIntervalMs);

async function shutdown() {
  for (const [, rec] of activeRecordings) {
    try { rec.subscription.destroy(); } catch (_) {}
    try { rec.writeStream.end(); } catch (_) {}
    await safeUnlink(rec.filePath);
  }
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (e) => {
  logger.error("Uncaught exception: " + e.message);
  shutdown();
});

// -------------------- Thinking Sound --------------------
async function startThinkingSound(conn) {
  try {
    const gid = conn.joinConfig.guildId;
    const sset = guildSettings.get(gid) || defaultGuildSettings();
    const enabled = sset.trigger ? (sset.trigger.enabled !== false) : true;
    if (!enabled) { logger.info("Thinking sound: disabled"); return; }

    const oggPath = path.join(__dirname, "thinking.ogg");
    const mp3Path = path.join(__dirname, "thinking.mp3");
    let resource = null;

    if (fsSync.existsSync(oggPath)) {
      const stream = fsSync.createReadStream(oggPath);
      const probe = await demuxProbe(stream);
      resource = createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, inlineVolume: true });
      try { resource.volume.setVolume(1.0); } catch {}
      logger.info("Thinking sound: using local thinking.ogg");
    } else if (fsSync.existsSync(mp3Path)) {
      logger.info("Thinking sound: transcoding local thinking.mp3 via ffmpeg");
      const ffmpeg = new prism.FFmpeg({
        args: ["-hide_banner", "-loglevel", "error", "-i", mp3Path, "-vn", "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-f", "ogg", "pipe:1"]
      });
      const probe = await demuxProbe(ffmpeg);
      resource = createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, inlineVolume: true });
      try { resource.volume.setVolume(1.0); } catch {}
    } else {
      logger.warn("Thinking sound: missing local file. Place thinking.ogg (preferred) or thinking.mp3 next to the bot file.");
      return;
    }

    thinkingActive.set(gid, true);
    const player = getOrCreateGuildPlayer(conn);
    player.on?.("error", (e) => logger.warn("Thinking player error: " + e.message));
    player.play(resource);

    const onState = (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Playing) {
        logger.info("Thinking sound: playing (local)");
        player.off("stateChange", onState);
      }
    };
    player.once("stateChange", onState);
  } catch (e) {
    logger.warn("Thinking sound error: " + e.message);
  }
}

function interruptThinking(conn) {
  try {
    const gid = conn.joinConfig.guildId;
    if (!thinkingActive.get(gid)) return;
    const p = getOrCreateGuildPlayer(conn);
    p.stop(true);
    thinkingActive.delete(gid);
    logger.info("Thinking sound: interrupted before TTS");
  } catch (e) {
    logger.warn("Interrupt thinking error: " + e.message);
  }
}

function getGuildQueue(gid) {
  return guildQueues.get(gid) || [];
}

function clearQueue(gid) {
  guildQueues.set(gid, []);
}

function skipCurrent(conn) {
  try { getOrCreateGuildPlayer(conn).stop(true); } catch (e) { logger.warn("Skip failed: " + e.message); }
}

// -------------------- Start --------------------
(async () => {
  try { await client.login(config.discordToken); } catch (err) {
    logger.error("Failed to login: " + err.message);
    process.exit(1);
  }
})();