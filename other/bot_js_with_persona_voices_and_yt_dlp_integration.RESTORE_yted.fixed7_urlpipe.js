
// Unified yt-dlp loader (classic syntax to avoid parser hiccups)
function __loadYTDLP() {
  try {
    var m = require("yt-dlp-exec");
    if (m && typeof m.raw === "function") return m;
  } catch (e) {}
  try {
    var m2 = require("youtube-dl-exec");
    if (m2 && typeof m2.raw === "function") return m2;
  } catch (e2) {}
  return null;
}
const ytdlpRaw = __loadYTDLP();

// ytdl fallback loader (prefer @distube/ytdl-core, then ytdl-core)
const ytdl = (()=>{
  try { return require("@distube/ytdl-core"); }
  catch { try { return require("ytdl-core"); } catch { return null; } }
})();


// Discord Voice Bot - PCM + TTS + Queue + Slash Commands (+ persona/voices + yt-dlp)
/* Requires (install these):
   npm i discord.js @discordjs/voice prism-media winston openai @google-cloud/speech @google-cloud/text-to-speech
npm i youtube-dl-exec ffmpeg-static ytdl-core
   
   Node 18+ recommended.
*/

const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require("discord.js");

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
const winston = require("winston");
require("libsodium-wrappers");

// New deps for out-of-the-box media

try {
  const ytdlpMod = require("youtube-dl-exec");
  // prefer the canonical .raw if present
  if (ytdlpMod && typeof ytdlpMod.raw === "function") ytdlpRaw = ytdlpMod.raw;
  // some packaging envs expose the function under .default
  else if (ytdlpMod && ytdlpMod.default && typeof ytdlpMod.default.raw === "function") ytdlpRaw = ytdlpMod.default.raw;
} catch {}


const ffmpegPath = require("ffmpeg-static"); // bundles ffmpeg binary
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath; // prism-media respects this

// -------------------- Config --------------------
const config = {
  discordToken: process.env.DISCORD_TOKEN,
  googleKeyFilename: process.env.GOOGLE_KEY_PATH,
  openaiApiKey: process.env.OPENAI_API_KEY,
  minAudioDuration: 1000,   // ms
  languageCode: "en-US",
  openaiModel: "gpt-4o-mini",
  silenceDuration: 700,     // ms of silence to end capture
  cleanupIntervalMs: 120000, // ms
  devGuildId: process.env.DEV_GUILD_ID || ""
};

function validateConfig() {
  for (const [name, val] of [["DISCORD_TOKEN", config.discordToken],["GOOGLE_KEY_PATH", config.googleKeyFilename],["OPENAI_API_KEY", config.openaiApiKey]]) {
    if (!val) { console.error("Missing env var:", name); process.exit(1); }
  }
}

// -------------------- Logger --------------------
winston.addColors({ error: "bold red", warn: "bold yellow", info: "green", debug: "cyan" });
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});
logger.info(`Booting VoiceBot from ${__filename}`);
logger.info(`Process PID: ${process.pid}`);

// --- Boot guard: ensure startup logic runs exactly once ---
let __BOOT_HAS_RUN__ = false;
function runBootOnce(fn){
  if(__BOOT_HAS_RUN__) return false;
  __BOOT_HAS_RUN__ = true;
  console.log(`[boot-guard] Boot path accepted @ ${new Date().toISOString()} (pid ${process.pid})`);
  return Promise.resolve(fn());
}

// Track command registration to prevent double registration
let __COMMANDS_REGISTERED__ = false;

// -------------------- Clients --------------------
validateConfig();
const client = new Client({
  intents: [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates],
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
    // New: persona string configurable per guild
    persona:
      "You are the spirit of Aleister Crowley, speaking aloud in a live Discord voice chat on the server 'Syzygy'. You are hearing users, not reading messages—address listeners directly. Keep responses brief, vivid, and suited for text-to-speech; avoid markdown/emojis, and do not mention being an AI. Stay in character unless a user explicitly says 'drop character'."
  };
}

function loadSettings() { try { const raw = require(SETTINGS_FILE); for (const [gid,s] of Object.entries(raw)) guildSettings.set(gid,s); } catch (e) {} }
async function saveSettings(){ try { await fs.writeFile(SETTINGS_FILE, JSON.stringify(Object.fromEntries(guildSettings.entries()), null, 2)); } catch (e) {} }
loadSettings();

// -------------------- Memory --------------------
const channelHistories=new Map();
const MAX_MEMORY_MESSAGES=6;
function getChannelHistory(id){return channelHistories.get(id)||[]}
function setChannelHistory(id,h){while(h.length>MAX_MEMORY_MESSAGES)h.shift();channelHistories.set(id,h)}
function pushHistory(id,role,content){const h=getChannelHistory(id);h.push({role,content});setChannelHistory(id,h)}

// -------------------- Helpers --------------------
const VOICE_PRESETS={
  "en-US:female":{languageCode:"en-US",name:"en-US-Neural2-F",ssmlGender:"FEMALE"},
  "en-US:male":{languageCode:"en-US",name:"en-US-Neural2-D",ssmlGender:"MALE"},
  "en-GB:female":{languageCode:"en-GB",name:"en-GB-Neural2-F",ssmlGender:"FEMALE"},
  "en-GB:male":{languageCode:"en-GB",name:"en-GB-Neural2-D",ssmlGender:"MALE"},
  "nl-NL:female":{languageCode:"nl-NL",name:"nl-NL-Standard-A",ssmlGender:"FEMALE"},
  "nl-NL:male":{languageCode:"nl-NL",name:"nl-NL-Standard-B",ssmlGender:"MALE"}
};

const escapeAtAndHash=str=>String(str??"").replace(/[@#]/g,"");
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const isAdmin=m=>m?.permissions?.has(PermissionFlagsBits.Administrator)||m?.permissions?.has(PermissionFlagsBits.ManageGuild);
const replyEphemeral=(i,c)=>i.reply({content:c,flags:MessageFlags.Ephemeral});
const deferEphemeral=i=>i.deferReply({flags:MessageFlags.Ephemeral});

async function resolveDisplayName(guild,userId){
  try{const m=await guild.members.fetch(userId);return m.displayName||m.user.username||userId;}catch{
    try{const u=await client.users.fetch(userId);return u.username||userId;}catch{return userId;}}
}

function shouldTriggerWake(transcript, guildId) {
  try {
    const s = guildSettings.get(guildId) || defaultGuildSettings();
    const wakeWord = s.wake && s.wake.enabled
      ? String(s.wake.word || "hey bot").toLowerCase()
      : null;
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

// ---- File helper (fixed) ----
async function safeUnlink(f) {
  try { await fs.unlink(f); } catch (e) { /* ignore */ }
}

// ---- Music helpers ----
async function createAudioResourceFromUrl(url){
  const res = await fetch(url, { headers: { "range": "bytes=0-" } });
  if (!res.ok || !res.body) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const { Readable } = require("stream");
  const nodeStream = Readable.fromWeb(res.body);
  return createAudioResource(nodeStream, { inputType: StreamType.Arbitrary, metadata: { title: url } });
}

function isYouTubeUrl(u){
  try{ const x=new URL(u); return ["www.youtube.com","youtube.com","youtu.be","m.youtube.com"].includes(x.hostname); }catch{ return false; }
}





async function ytDlpGetAudioURL(videoUrl) {
  return await new Promise((resolve) => {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const baseArgs = [
      "-f","bestaudio[ext=webm]/bestaudio/best",
      "--no-playlist",
      "--force-ipv4",
      "--geo-bypass",
      "--user-agent", UA,
      "-g", // print direct media url
      videoUrl
    ];
    const browser = process.env.YTDLP_COOKIES_BROWSER;
    const cookiesFile = process.env.YTDLP_COOKIES_FILE;
    if (browser) baseArgs.splice(6, 0, "--cookies-from-browser", browser);
    if (cookiesFile) baseArgs.splice(6, 0, "--cookies", cookiesFile);

    let cp;
    let stdout = "";
    let stderr = "";

    function done() {
      const url = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      if (url.startsWith("http")) resolve(url);
      else {
        logger?.warn && logger.warn("[yt] -g returned no url.", { stdout: stdout.trim(), stderr: stderr.trim() });
        resolve("");
      }
    }

    try {
      if (typeof __ytdlpExec !== "undefined" && __ytdlpExec && typeof __ytdlpExec.raw === "function") {
        logger?.info && logger.info("[yt] using youtube-dl-exec.raw (-g) to get media URL");
        cp = __ytdlpExec.raw("", { // youtube-dl-exec requires the URL separate; we pass via args override
          // We'll override the args entirely:
          _: baseArgs.filter(x => x !== videoUrl), // everything but the URL
        });
      } else {
        const { spawn } = require("child_process");
        const bin = process.env.YTDLP_PATH || "yt-dlp";
        logger?.info && logger.info("[yt] spawning yt-dlp (-g):", `"${bin}"`, baseArgs.join(" "));
        cp = spawn(bin, baseArgs, { stdio: ["ignore","pipe","pipe"] });
      }
    } catch (e) {
      logger?.error && logger.error("[yt] failed to start yt-dlp -g:", e.message || e);
      return resolve("");
    }

    cp.stdout?.on("data", d => { stdout += String(d); });
    cp.stderr?.on("data", d => { stderr += String(d); logger?.info && logger.info("[yt-dlp]", String(d).trim()); });
    cp.on?.("close", (code, signal) => {
      logger?.info && logger.info("[yt-dlp] -g closed with", { code, signal });
      done();
    });
    cp.on?.("error", e => {
      logger?.error && logger.error("[yt] yt-dlp -g error:", e.message || e);
      resolve("");
    });
  });
}

function streamFromUrl(mediaUrl, headers = {}) {
  const https = require("https");
  const url = require("url");
  const maxRedirects = 5;
  const UA = headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  return new Promise((resolve, reject)=>{
    let redirects = 0;
    function go(u){
      const opts = { ...url.parse(u), headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...headers } };
      https.get(opts, (res)=>{
        const loc = res.headers.location;
        if ([301,302,303,307,308].includes(res.statusCode || 0) && loc && redirects < maxRedirects) {
          redirects++; return go(url.resolve(u, loc));
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


async function createAudioResourceFromYt(url){
  // 1) Try extraction of a direct audio URL via yt-dlp -g, then stream it
  try {
    const mediaUrl = await ytDlpGetAudioURL(url);
    if (mediaUrl) {
      logger?.info && logger.info("[yt] media URL:", mediaUrl.slice(0, 120) + (mediaUrl.length>120?"…":""));
      const netStream = await streamFromUrl(mediaUrl);
      // Try direct demux first
      try {
        const direct = await demuxProbe(netStream);
        logger?.info && logger.info("[yt] direct demux type:", direct?.type);
        return createAudioResource(direct.stream, { inputType: direct.type, metadata: { title: url } });
      } catch (e) {
        logger?.warn && logger.warn("[yt] direct demux on URL failed, falling back to ffmpeg:", e.message || e);
      }
      // ffmpeg fallback
      const ff = new prism.FFmpeg({
        args: ["-hide_banner","-loglevel","error","-i","pipe:0","-vn","-c:a","libopus","-b:a","128k","-ar","48000","-ac","2","-f","ogg","pipe:1"]
      });
      ff.on("error", e => logger?.error && logger.error("ffmpeg error:", e.message || e));
      netStream.on("error", e => logger?.error && logger.error("http stream error:", e.message || e));
      netStream.pipe(ff);
      const probe = await demuxProbe(ff);
      logger?.info && logger.info("[yt] demuxProbe type:", probe?.type);
      return createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, metadata: { title: url } });
    }
  } catch (e) {
    logger?.warn && logger.warn("[yt] URL extraction path failed:", e.message || e);
  }

  // 2) Fallback to stdout pipe mode (previous behavior)
  let inputStream;
  try {
    if (typeof __ytdlpExec !== "undefined" && __ytdlpExec && typeof __ytdlpExec.raw === "function") {
      logger?.info && logger.info("[yt] using youtube-dl-exec.raw (pipe mode)");
      const cp = __ytdlpExec.raw(url, {
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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...(process.env.YTDLP_COOKIES_BROWSER ? { "cookies-from-browser": process.env.YTDLP_COOKIES_BROWSER } : {}),
        ...(process.env.YTDLP_COOKIES_FILE ? { cookies: process.env.YTDLP_COOKIES_FILE } : {})
      });
      cp.on("error", (e)=> (logger?.error ? logger.error("yt-dlp error: " + e.message) : console.error(e)));
      cp.stderr?.on("data", d => logger?.info && logger.info("[yt-dlp]", String(d).trim()));
      cp.on("close", (code, signal) => logger?.info && logger.info("[yt-dlp] process closed with", { code, signal }));
      inputStream = cp.stdout;
    } else {
      const { spawn } = require("child_process");
      const baseArgs = [
        "-f","bestaudio/best",
        "-o","-",
        "--no-playlist",
        "--force-ipv4",
        "--geo-bypass",
        "--user-agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      ];
      const browser = process.env.YTDLP_COOKIES_BROWSER;
      const cookiesFile = process.env.YTDLP_COOKIES_FILE;
      if (browser) baseArgs.push("--cookies-from-browser", browser);
      if (cookiesFile) baseArgs.push("--cookies", cookiesFile);
      const bin = process.env.YTDLP_PATH || "yt-dlp";
      const args = baseArgs.concat([url]);
      logger?.info && logger.info("[yt] spawning yt-dlp (pipe mode):", `"${bin}"`, args.join(" "));
      const cp = spawn(bin, args, { stdio: ["ignore","pipe","pipe"] });
      cp.on("error", (e)=> (logger?.error ? logger.error("yt-dlp spawn error: " + e.message) : console.error(e)));
      cp.stderr?.on("data", d => logger?.info && logger.info("[yt-dlp]", String(d).trim()));
      cp.on("close", (code, signal) => logger?.info && logger.info("[yt-dlp] process closed with", { code, signal }));
      inputStream = cp.stdout;
    }
  } catch (e) {
    throw e;
  }

  // Try direct demux first
  try {
    const direct = await demuxProbe(inputStream);
    logger?.info && logger.info("[yt] direct demux type:", direct?.type);
    return createAudioResource(direct.stream, { inputType: direct.type, metadata: { title: url } });
  } catch (e) {
    logger?.warn && logger.warn("[yt] direct demux failed, falling back to ffmpeg:", e.message || e);
  }

  // ffmpeg fallback
  const ff = new prism.FFmpeg({
    args: ["-hide_banner","-loglevel","error","-i","pipe:0","-vn","-c:a","libopus","-b:a","128k","-ar","48000","-ac","2","-f","ogg","pipe:1"]
  });
  ff.on("error", e => logger?.error && logger.error("ffmpeg error:", e.message || e));
  if (inputStream && inputStream.on) inputStream.on("error", e => logger?.error && logger.error("yt stream error:", e.message || e));
  inputStream.pipe(ff);
  const probe = await demuxProbe(ff);
  logger?.info && logger.info("[yt] demuxProbe type:", probe?.type);
  return createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, metadata: { title: url } });
}





function enqueueResource(conn, resource){
  const gid = conn.joinConfig.guildId;
  const q = guildQueues.get(gid) || [];
  const title = (resource && resource.metadata && resource.metadata.title) || "audio";
  q.push({ resource, title });
  guildQueues.set(gid, q);
  const p = getOrCreateGuildPlayer(conn);
  if (p.state.status === "idle" && !guildSpeaking.get(gid)) handleGuildQueue(conn);
}

async function isBotUser(id){try{if(!id)return false;if(client.user&&id===client.user.id)return true;const c=client.users.cache.get(id);if(c)return!!c.bot;const f=await client.users.fetch(id).catch(()=>null);return!!(f&&f.bot);}catch{return false}}

async function transcribePCM(pcm,gid){const b=await fs.readFile(pcm);const s=guildSettings.get(gid)||defaultGuildSettings();const [r]=await speechClient.recognize({config:{encoding:"LINEAR16",sampleRateHertz:48000,languageCode:s.lang||config.languageCode,enableAutomaticPunctuation:true},audio:{content:b.toString("base64")}});return(r.results||[]).map(x=>x.alternatives?.[0]?.transcript||"").join(" ").trim()}

async function getAIResponse(prompt,chId,gid){
  const prior=getChannelHistory(chId);
  const s = guildSettings.get(gid) || defaultGuildSettings();
  const sys = String(s.persona || defaultGuildSettings().persona);
  const messages=[{role:"system",content:sys},...prior,{role:"user",content:prompt}];
  try {
    const c=await openai.chat.completions.create({model:config.openaiModel,messages});
    return c.choices?.[0]?.message?.content?.trim()||"(no response)";
  } catch (e) {
    logger.error("OpenAI error: "+e.message);
    return "I'm having trouble thinking right now.";
  }
}

async function logToSetChannel(gid,content,fallback=null){try{const s=guildSettings.get(gid)||defaultGuildSettings();let target=null;if(s.logChannelId)target=await client.channels.fetch(s.logChannelId).catch(()=>null);if(!target&&fallback)target=fallback;if(target?.isTextBased?.())await target.send(escapeAtAndHash(content));}catch(e){logger.error("logToSetChannel error: "+e.message)}}

function createVoiceConfig(s){const v={languageCode:s.voice?.languageCode||"en-US"};if(s.voice?.ssmlGender)v.ssmlGender=s.voice.ssmlGender;if(s.voice?.name)v.name=s.voice.name;return v;}

// -------------------- TTS --------------------
function getOrCreateGuildPlayer(conn){const gid=conn.joinConfig.guildId;let p=guildPlayers.get(gid);if(!p){p=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Pause}});conn.subscribe(p);

    // Ensure a single error listener is attached once per player
if (!p.__hasErrorHandler) {
  p.__hasErrorHandler = true;
  p.on("error", (e) => logger?.warn?.(`AudioPlayer error [${gid}]: ${e?.message}`));
}

p.on("stateChange",(o,n)=>{if(n.status==="idle")handleGuildQueue(conn)});guildPlayers.set(gid,p);}return p}
function handleGuildQueue(conn){
  const gid = conn.joinConfig.guildId;
  const q = guildQueues.get(gid) || [];
  if (q.length === 0){ guildSpeaking.set(gid,false); return; }

  const next = q.shift();
  guildQueues.set(gid, q);
  guildSpeaking.set(gid, true);

  if (next && next.resource){ getOrCreateGuildPlayer(conn).play(next.resource); return; }
  if (next && next.buffer){ playOggOpus(conn, next.buffer); return; }

  guildSpeaking.set(gid,false);
}
async function synthesizeTTS(text,gid){const s=guildSettings.get(gid)||defaultGuildSettings();const req={input:{text},voice:createVoiceConfig(s),audioConfig:{audioEncoding:"OGG_OPUS",sampleRateHertz:48000,speakingRate:s.rate??1.0,pitch:s.pitch??0.0}};const [r]=await ttsClient.synthesizeSpeech(req);return Buffer.from(r.audioContent,"base64")}
function playOggOpus(conn,buf){const {Readable}=require("stream");const stream=Readable.from([buf]);getOrCreateGuildPlayer(conn).play(createAudioResource(stream,{inputType:StreamType.OggOpus}))}
async function speakText(conn,text){if(!text||!conn)return;const gid=conn.joinConfig.guildId;const buf=await synthesizeTTS(text,gid);const q=guildQueues.get(gid)||[];q.push({buffer:buf});guildQueues.set(gid,q);const p=getOrCreateGuildPlayer(conn);if(p.state.status==="idle"&&!guildSpeaking.get(gid))handleGuildQueue(conn)}

// -------------------- Voice connection helpers --------------------
function bindSpeakingListener(conn,ch){conn.on(VoiceConnectionStatus.Ready,()=>{logger.info(`Voice connection ready in guild ${conn.joinConfig.guildId}`);getOrCreateGuildPlayer(conn);conn.receiver.speaking.on("start",async uid=>{const gid=conn.joinConfig.guildId;if(guildSpeaking.get(gid))return;if(await isBotUser(uid))return;setupVoiceReceiver(conn,uid,ch)});});}

async function joinCurrentVoice(i){const ch=i.member?.voice?.channel;if(!ch)return replyEphemeral(i,"Join a voice channel first, then use /join.");const existing=getVoiceConnection(ch.guild.id);if(existing)return replyEphemeral(i,`Already connected to <#${existing.joinConfig.channelId}>.`);const conn=joinVoiceChannel({channelId:ch.id,guildId:ch.guild.id,adapterCreator:ch.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false});bindSpeakingListener(conn,i.channel);return replyEphemeral(i,`Joined voice: #${ch.name}. I will transcribe and speak replies.`)}

async function leaveVoice(i){const c=getVoiceConnection(i.guildId);if(!c)return replyEphemeral(i,"I am not in a voice channel.");try{c.destroy();}catch(_){}return replyEphemeral(i,"Left voice channel.")}

// -------------------- Voice pipeline --------------------
async function setupVoiceReceiver(conn,uid,ch){if(await isBotUser(uid))return;if(activeRecordings.has(uid))return;const r=conn.receiver;const pcm=path.join(__dirname,`temp_${Date.now()}_${uid}.pcm`);const ws=fsSync.createWriteStream(pcm);const start=Date.now();let sub;try{sub=r.subscribe(uid,{end:{behavior:EndBehaviorType.AfterSilence,duration:config.silenceDuration}});}catch(e){logger.error("Sub fail "+uid+": "+e.message);ws.end();return;}sub.pipe(new prism.opus.Decoder({rate:48000,channels:1,frameSize:960})).pipe(ws);activeRecordings.set(uid,{subscription:sub,writeStream:ws,startTime:start,filePath:pcm,channelId:ch.id,guildId:ch.guildId});ws.on("finish",async()=>{const dur=Date.now()-start;try{if(dur<config.minAudioDuration){logger.info("Skip short "+dur+"ms");return;}const gid=ch.guildId;const t=await transcribePCM(pcm,gid);if(!t){logger.info("Empty transcript");return;}const dn=await resolveDisplayName(ch.guild,uid);logger.info(`Transcript from ${dn} (${uid}): "${t}"`);await logToSetChannel(gid,`🗣️ [Transcript — ${dn}]: ${escapeAtAndHash(t)}`,ch);const wake=shouldTriggerWake(t,gid);if(!wake.triggered)return;if(!wake.remainder){const c=getVoiceConnection(ch.guildId);if(c)try{await speakText(c,"Yes?");}catch(e){logger.error("TTS error: "+e.message);}return;}pushHistory(ch.id,"user",wake.remainder);{const __c=getVoiceConnection(ch.guildId);if(__c){startThinkingSound(__c).catch(e=>logger.warn("Thinking(start) "+e.message));}}const ai=await getAIResponse(wake.remainder,ch.id,gid);logger.info(`LLM reply to ${dn}: "${ai}"`);await logToSetChannel(gid,`🤖 [LLM]: ${escapeAtAndHash(ai)}`,ch);pushHistory(ch.id,"assistant",ai);const c=getVoiceConnection(ch.guildId);if(c)try{interruptThinking(c);await speakText(c,ai);}catch(e){logger.error("TTS error: "+e.message);}}catch(e){logger.error("Audio error: "+e.message);}finally{activeRecordings.delete(uid);await safeUnlink(pcm);}});sub.on("error",e=>{logger.error("Sub error "+uid+": "+e.message);ws.end();});}

// -------------------- Slash commands (idempotent) --------------------
async function registerSlashCommands(){
  if (__COMMANDS_REGISTERED__) { logger.info("Slash commands already registered; skipping."); return; }
  __COMMANDS_REGISTERED__ = true;

  const join=new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel");

const stop = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop playback and clear the queue");

const skip = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Skip the current track");

const queue = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("Show the current playback queue");
  const leave=new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const setchannel=new SlashCommandBuilder().setName("setchannel").setDescription("Set the text channel for logs").addChannelOption(o=>o.setName("channel").setDescription("Target text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const voice=new SlashCommandBuilder().setName("voice").setDescription("Set TTS voice").addStringOption(o=>o.setName("language").setDescription("BCP-47 code").setRequired(true)).addStringOption(o=>o.setName("name").setDescription("Google voice name").setRequired(false));
  const presetChoices=Object.keys(VOICE_PRESETS).map(k=>({name:k,value:k}));
  const voicepreset=new SlashCommandBuilder().setName("voicepreset").setDescription("Pick a preset voice").addStringOption(o=>o.setName("preset").setDescription("Locale + gender").setRequired(true).addChoices(...presetChoices)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  const rate=new SlashCommandBuilder().setName("rate").setDescription("Set TTS speaking rate").addNumberOption(o=>o.setName("value").setDescription("Rate").setRequired(true).setMinValue(0.25).setMaxValue(4.0));
  const pitch=new SlashCommandBuilder().setName("pitch").setDescription("Set TTS pitch").addNumberOption(o=>o.setName("value").setDescription("Pitch").setRequired(true).setMinValue(-20).setMaxValue(20));
  const lang=new SlashCommandBuilder().setName("lang").setDescription("Set STT language code").addStringOption(o=>o.setName("code").setDescription("BCP-47 code").setRequired(true));
  const settings=new SlashCommandBuilder().setName("settings").setDescription("Show current guild settings");
  const wake=new SlashCommandBuilder().setName("wake").setDescription("Enable/disable wake word").addBooleanOption(o=>o.setName("enabled").setDescription("Enable?").setRequired(true)).addStringOption(o=>o.setName("word").setDescription("Wake word").setRequired(false));
  const say=new SlashCommandBuilder().setName("say").setDescription("Speak custom text in the current voice channel").addStringOption(o=>o.setName("text").setDescription("What should I say?").setRequired(true));

  // NEW: /play (enhanced with yt-dlp)
  const play = new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play audio from a URL or attachment in the current voice channel")
    .addStringOption(o => o.setName("url").setDescription("Direct link or YouTube URL").setRequired(false))
    .addAttachmentOption(o => o.setName("attachment").setDescription("Upload an audio file").setRequired(false));

  // NEW: /voices — list available Google TTS voices (optionally filter by language)
  const voices = new SlashCommandBuilder()
    .setName("voices")
    .setDescription("List available Google TTS voices (optionally filtered)")
    .addStringOption(o => o.setName("language").setDescription("Filter by BCP-47, e.g., en-US").setRequired(false));

  // NEW: /persona — set or view persona string
  const persona = new SlashCommandBuilder()
    .setName("persona")
    .setDescription("View or set the AI persona used for responses")
    .addStringOption(o => o.setName("text").setDescription("New persona text (omit to view current)"));

  const commands = [join.toJSON(),leave.toJSON(),setchannel.toJSON(),voice.toJSON(),voicepreset.toJSON(),rate.toJSON(),pitch.toJSON(),lang.toJSON(),settings.toJSON(),wake.toJSON(),say.toJSON(),
    play.toJSON(), voices.toJSON(), persona.toJSON(), stop.toJSON(), skip.toJSON(), queue.toJSON(), ];
  try{
    if(config.devGuildId){const g=await client.guilds.fetch(config.devGuildId).catch(()=>null);if(g){await g.commands.set(commands);logger.info("Slash commands registered to dev guild.");return;}logger.warn("DEV_GUILD_ID not found; falling back to global registration.");}
    await client.application.commands.set(commands);
    logger.info("Slash commands registered globally.");
  }catch(e){logger.error("Failed to register slash commands: "+e.message)}
}

// -------------------- Events (guarded) --------------------
async function onClientReady(){
  await runBootOnce(async ()=>{
    logger.info(`Logged in as ${client.user.tag}`);
    await registerSlashCommands();
  });
}
client.once("clientReady", onClientReady); // v15 name
client.once("ready", onClientReady);      // v14 compatibility

client.on("interactionCreate", async (i)=>{
  if(!i.isChatInputCommand())return;const gid=i.guildId;const current=guildSettings.get(gid)||defaultGuildSettings();
  try{
    switch(i.commandName){
      case "join": return await joinCurrentVoice(i);
      case "leave": if(!isAdmin(i.member)) return replyEphemeral(i,"Admins only."); return await leaveVoice(i);
      case "setchannel": {
  if (!isAdmin(i.member)) { await replyEphemeral(i, "Admins only."); break; }
  const ch = i.options.getChannel("channel");
  if (!ch || ch.type !== ChannelType.GuildText) { await replyEphemeral(i, "Please choose a text channel."); break; }
  current.logChannelId = ch.id;
  guildSettings.set(gid, current);
  await saveSettings();
  await replyEphemeral(i, `Log channel set to #${ch.name}`);
  break;
}

      case "voices": {
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
          if (!voices.length) { await i.editReply(lang?`No voices for ${lang}.`:"No voices found."); break; }
          // Discord limit: chunk the list
          const chunks = [];
          let buf = "";
          for (const line of voices) {
            if ((buf + line + "\n").length > 1800) { chunks.push(buf); buf = ""; }
            buf += line + "\n";
          }
          if (buf) chunks.push(buf);
          await i.editReply(`Found ${voices.length} voices${lang?` for ${lang}`:""}.\n` + chunks[0]);
          // If super long, follow up with the rest
          for (let ci=1; ci<chunks.length; ci++) {
            await i.followUp({ content: chunks[ci], flags: MessageFlags.Ephemeral });
          }
        } catch (e) {
          await i.editReply("Voice listing failed: " + e.message);
        }
        break;
      }

      case "persona": {
        const txt = i.options.getString("text");
        if (!isAdmin(i.member)) return replyEphemeral(i, "Admins only.");
        if (!txt) {
          return replyEphemeral(i, "Current persona:\n" + (current.persona || "(not set)"));
        }
        if (txt.toLowerCase() === "reset") {
          current.persona = defaultGuildSettings().persona;
          guildSettings.set(gid,current); await saveSettings();
          return replyEphemeral(i, "Persona reset to default.");
        }
        current.persona = txt.slice(0, 2000);
        guildSettings.set(gid,current); await saveSettings();
        return replyEphemeral(i, "Persona updated for this guild.");
      }
    

case "play": {
        const gid = i.guild?.id;
        const url = i.options.getString("url");
        const att = i.options.getAttachment("attachment");
        if (!url && !att) { await replyEphemeral(i, "Provide a URL (YouTube or direct audio) or attach a file."); break; }

        let conn = getVoiceConnection(gid);
        if (!conn){
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

        try{
          const src = url || att?.url;
          let resource;
          if (url && isYouTubeUrl(url)) {
            resource = await createAudioResourceFromYt(url);
          } else if (att) {
            resource = await createAudioResourceFromUrl(att.url);
          } else {
            const ok = /\.(mp3|ogg|oga|wav|m4a|aac)$/i.test(src || "");
            if (!ok && !isYouTubeUrl(src)) { await i.editReply("I can stream YouTube links or direct audio URLs (mp3/ogg/wav/m4a/aac)."); break; }
            resource = isYouTubeUrl(src) ? await createAudioResourceFromYt(src) : await createAudioResourceFromUrl(src);
          }

          enqueueResource(conn, resource);
          const title = resource.metadata?.title || (att ? att.name : "audio");
          await i.editReply(`Queued: ${title}`);
        }catch(e){
          logger.error("Play error: " + e.message);
          await i.editReply("Could not start playback: " + e.message);
        }
        break;
      }
case "stop": {
      const gid = i.guildId;
      const conn = getVoiceConnection(gid);
      if (!conn) { await replyEphemeral(i, "I'm not in a voice channel."); break; }
      clearQueue(gid);
      skipCurrent(conn);
      await replyEphemeral(i, "Stopped playback and cleared the queue.");
      break;
    }
case "skip": {
      const gid = i.guildId;
      const conn = getVoiceConnection(gid);
      if (!conn) { await replyEphemeral(i, "I'm not in a voice channel."); break; }
      const q = getGuildQueue(gid);
      const player = getOrCreateGuildPlayer(conn);
      if (q.length === 0 && player.state.status === "idle") {
        await replyEphemeral(i, "Nothing to skip.");
        break;
      }
      skipCurrent(conn);
      await replyEphemeral(i, "Skipped.");
      break;
    }
case "queue": {
      const gid = i.guildId;
      const conn = getVoiceConnection(gid);
      const q = getGuildQueue(gid);
      const player = conn ? getOrCreateGuildPlayer(conn) : null;
      const now = player?.state?.resource?.metadata?.title;

      let lines = [];
      if (now) lines.push(`**Now playing:** ${now}`);
      if (q.length) {
        lines.push(`**Up next (${q.length}):**`);
        q.slice(0, 10).forEach((item, idx) => {
          const t = item?.title || "audio";
          lines.push(`${idx + 1}. ${t}`);
        });
        if (q.length > 10) lines.push(`…and ${q.length - 10} more`);
      }
      if (!now && !q.length) lines.push("Queue is empty.");
      await replyEphemeral(i, lines.join("\n"));
      break;
    }
}
  }catch(e){ logger.error("Slash command error: "+e.message); if(i.deferred||i.replied){ await i.followUp({content:"Error: "+e.message, flags: MessageFlags.Ephemeral}).catch(()=>{});} else { await replyEphemeral(i,"Error: "+e.message);} }

    
    
    

});

// -------------------- Cleanup & Shutdown --------------------
setInterval(async()=>{const now=Date.now();for(const [uid,rec] of activeRecordings){if(now-rec.startTime>10*60*1000){try{rec.subscription.destroy();}catch(_){}try{rec.writeStream.end();}catch(_){}await safeUnlink(rec.filePath);activeRecordings.delete(uid);}}},config.cleanupIntervalMs);
async function shutdown(){for(const[,rec]of activeRecordings){try{rec.subscription.destroy();}catch(_){}try{rec.writeStream.end();}catch(_){}await safeUnlink(rec.filePath);}try{await client.destroy();}catch(_){}process.exit(0);}process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);

// -------------------- Start --------------------
(async()=>{try{await client.login(config.discordToken);}catch(err){logger.error("Failed to login: "+err.message);process.exit(1);}})();

// === Thinking sound helpers (LOCAL FILE, no network) ===
async function startThinkingSound(conn){
  try{
    const gid = conn.joinConfig.guildId;
    const sset = guildSettings.get(gid) || defaultGuildSettings();
    const enabled = sset.trigger ? (sset.trigger.enabled !== false) : true;
    if (!enabled) { logger.info("Thinking sound: disabled"); return; }

    const fs = require("fs");
    const path = require("path");
    const prism = require("prism-media");
    

// --- yt-dlp support: prefer youtube-dl-exec.raw, else spawn system yt-dlp ---
let __ytdlpExec = null;
try {
  const _m = require("youtube-dl-exec");
  

// --- yt-dlp support: prefer youtube-dl-exec.raw, else spawn system yt-dlp ---
let __ytdlpExec = null;
try {
  const _m = require("youtube-dl-exec");
  __ytdlpExec = (_m && typeof _m.raw === "function")
    ? _m
    : (_m && _m.default && typeof _m.default.raw === "function")
      ? _m.default
      : null;
} catch {}

const __YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp"; // set to full path to yt-dlp.exe if needed

function __spawnYtDlp(url, extraArgs = []){
  const { spawn } = require("child_process");
  const baseArgs = [
    "-f","bestaudio/best",
    "-o","-",
    "--no-playlist",
    "--force-ipv4",
    "--geo-bypass",
    "--user-agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  ];
  const browser = process.env.YTDLP_COOKIES_BROWSER;
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;
  if (browser) baseArgs.push("--cookies-from-browser", browser);
  if (cookiesFile) baseArgs.push("--cookies", cookiesFile);

  const args = baseArgs.concat(extraArgs).concat([url]);
  const cp = spawn(__YTDLP_BIN, args, { stdio: ["ignore","pipe","pipe"] });
  cp.on("error", (e)=> (logger?.error ? logger.error("yt-dlp spawn error: " + e.message) : console.error(e)));
  cp.stderr?.on("data", d => logger?.debug && logger.debug("[yt-dlp] " + String(d)));
  return cp;
}

__ytdlpExec = (_m && typeof _m.raw === "function")
    ? _m
    : (_m && _m.default && typeof _m.default.raw === "function")
      ? _m.default
      : null;
} catch {}

const __YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp"; // set to full path to yt-dlp.exe if needed

function __spawnYtDlp(url, extraArgs = []){
  const { spawn } = require("child_process");
  const baseArgs = [
    "-f","bestaudio/best",
    "-o","-",
    "--no-playlist",
    "--force-ipv4",
    "--geo-bypass",
    "--user-agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  ];
  const browser = process.env.YTDLP_COOKIES_BROWSER;
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;
  if (browser) baseArgs.push("--cookies-from-browser", browser);
  if (cookiesFile) baseArgs.push("--cookies", cookiesFile);

  const args = baseArgs.concat(extraArgs).concat([url]);
  const cp = spawn(__YTDLP_BIN, args, { stdio: ["ignore","pipe","pipe"] });
  cp.on("error", (e)=> (logger?.error ? logger.error("yt-dlp spawn error: " + e.message) : console.error(e)));
  cp.stderr?.on("data", d => logger?.debug && logger.debug("[yt-dlp] " + String(d)));
  return cp;
}

const { demuxProbe, createAudioResource, StreamType } = require("@discordjs/voice");

    // Prefer pre-encoded local Ogg Opus to avoid any transcoding latency.
    const oggPath = path.join(__dirname, "thinking.ogg");
    const mp3Path = path.join(__dirname, "thinking.mp3");
    let resource = null;

    if (fs.existsSync(oggPath)) {
      const stream = fs.createReadStream(oggPath);
      const probe = await demuxProbe(stream);
      resource = createAudioResource(probe.stream, { inputType: probe.type || StreamType.OggOpus, inlineVolume: true });
      try { resource.volume.setVolume(1.0); } catch {}
      logger.info("Thinking sound: using local thinking.ogg");
    } else if (fs.existsSync(mp3Path)) {
      // Fallback: transcode local MP3 -> OGG/Opus with ffmpeg (provided by ffmpeg-static)
      logger.info("Thinking sound: transcoding local thinking.mp3 via ffmpeg");
      const ffmpeg = new prism.FFmpeg({
        args: ["-hide_banner","-loglevel","error","-i", mp3Path, "-vn", "-c:a","libopus","-b:a","96k","-ar","48000","-ac","2","-f","ogg","pipe:1"]
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
    player.on?.("error", (e)=> logger.warn("Thinking player error: "+e.message));
    player.play(resource);

    const onState = (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Playing) {
        logger.info("Thinking sound: playing (local)");
        player.off("stateChange", onState);
      }
    };
    player.once("stateChange", onState);
  }catch(e){ logger?.warn?.("Thinking sound error: "+e.message); }
}

function interruptThinking(conn){
  try{
    const gid = conn.joinConfig.guildId;
    if (!thinkingActive.get(gid)) return;
    const p = getOrCreateGuildPlayer(conn);
    p.stop(true);
    thinkingActive.delete(gid);
    logger.info("Thinking sound: interrupted before TTS");
  }catch(e){ logger?.warn?.("Interrupt thinking error: "+e.message); }
}


function getGuildQueue(gid){
  return guildQueues.get(gid) || [];
}
function clearQueue(gid){
  guildQueues.set(gid, []);
}
function skipCurrent(conn){
  try { getOrCreateGuildPlayer(conn).stop(true); } catch(e){ if (logger?.warn) logger.warn("Skip failed: "+e.message); }
}