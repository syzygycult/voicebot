// Discord Voice Bot - PCM + TTS + Queue + Slash Commands (CLEANED + single-boot guards)
/* Requires:
   - discord.js ^14 (ready) and future v15 (clientReady)
   - @discordjs/voice ^0.16
   - openai ^4
   - @google-cloud/speech, @google-cloud/text-to-speech
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
  StreamType

const { SpeechClient } = require("@google-cloud/speech");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const OpenAI = require("openai");
const prism = require("prism-media");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const winston = require("winston");
require("libsodium-wrappers");

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
    logChannelId: null
  };
}

function loadSettings() { try { const raw = require(SETTINGS_FILE); for (const [gid,s] of Object.entries(raw)) guildSettings.set(gid,s);}}
async function saveSettings(){ try{ await fs.writeFile(SETTINGS_FILE,JSON.stringify(Object.fromEntries(guildSettings.entries()),null,2)); }}
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

function shouldTriggerWake(transcript,guildId){try{const s=guildSettings.get(guildId)||defaultGuildSettings();const wakeWord=s.wake&&s.wake.enabled?String(s.wake.word||"hey bot").toLowerCase():null;if(!wakeWord)return{triggered:true,remainder:transcript};const t=String(transcript||"").trim().toLowerCase();const pattern=new RegExp("^"+wakeWord.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")+"\\b[,:-]?\\s*(.*)$","i");const m=t.match(pattern);if(!m)return{triggered:false,remainder:""};return{triggered:true,remainder:m[1]||""};}catch(_){return{triggered:true,remainder:transcript}}}

catch (e) {
    // ignore missing file or unlink errors
  }
}


// ---- File helper (fixed) ----
async function safeUnlink(f) {
  try {
    await fs.unlink(f);
  } catch (e) {
    // ignore missing file or unlink errors
  }
}

// ---- Music helpers (no extra deps; Node 18+ for fetch) ----
async function createAudioResourceFromUrl(url){
  const res = await fetch(url, { headers: { "range": "bytes=0-" } });
  if (!res.ok || !res.body) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const { Readable } = require("stream");
  const nodeStream = Readable.fromWeb(res.body);
  return createAudioResource(nodeStream, { inputType: StreamType.Arbitrary, metadata: { title: url } });
}

function enqueueResource(conn, resource){
  const gid = conn.joinConfig.guildId;
  const q = guildQueues.get(gid) || [];
  q.push({ resource });
  guildQueues.set(gid, q);
  const p = getOrCreateGuildPlayer(conn);
  if (p.state.status === "idle" && !guildSpeaking.get(gid)) handleGuildQueue(conn);
}}
async function isBotUser(id){try{if(!id)return false;if(client.user&&id===client.user.id)return true;const c=client.users.cache.get(id);if(c)return!!c.bot;const f=await client.users.fetch(id).catch(()=>null);return!!(f&&f.bot);}catch{return false}}

async function transcribePCM(pcm,gid){const b=await fs.readFile(pcm);const s=guildSettings.get(gid)||defaultGuildSettings();const [r]=await speechClient.recognize({config:{encoding:"LINEAR16",sampleRateHertz:48000,languageCode:s.lang||config.languageCode,enableAutomaticPunctuation:true},audio:{content:b.toString("base64")}});return(r.results||[]).map(x=>x.alternatives?.[0]?.transcript||"").join(" ").trim()}

async function getAIResponse(prompt,chId){const prior=getChannelHistory(chId);const messages=[{role:"system",content:"You are the spirit of Aleister Crowley, speaking aloud in a live Discord voice chat on the server 'Syzygy'. You are hearing users, not reading messages—address listeners directly. Keep responses brief, vivid, and suited for text-to-speech; avoid markdown/emojis, and do not mention being an AI. Stay in character unless a user explicitly says 'drop character'."},...prior,{role:"user",content:prompt}];const c=await openai.chat.completions.create({model:config.openaiModel,messages});return c.choices?.[0]?.message?.content?.trim()||"(no response)"}

async function logToSetChannel(gid,content,fallback=null){try{const s=guildSettings.get(gid)||defaultGuildSettings();let target=null;if(s.logChannelId)target=await client.channels.fetch(s.logChannelId).catch(()=>null);if(!target&&fallback)target=fallback;if(target?.isTextBased?.())await target.send(escapeAtAndHash(content));}catch(e){logger.error("logToSetChannel error: "+e.message)}}

function createVoiceConfig(s){const v={languageCode:s.voice?.languageCode||"en-US"};if(s.voice?.ssmlGender)v.ssmlGender=s.voice.ssmlGender;if(s.voice?.name)v.name=s.voice.name;return v;}

// -------------------- TTS --------------------
function getOrCreateGuildPlayer(conn){const gid=conn.joinConfig.guildId;let p=guildPlayers.get(gid);if(!p){p=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Pause}});conn.subscribe(p);p.on("stateChange",(o,n)=>{if(n.status==="idle")handleGuildQueue(conn)});guildPlayers.set(gid,p);}return p}
function handleGuildQueue(conn){
  const gid = conn.joinConfig.guildId;
  const q = guildQueues.get(gid) || [];
  if (q.length === 0){ guildSpeaking.set(gid,false); return; }

  const next = q.shift();
  guildQueues.set(gid, q);
  guildSpeaking.set(gid, true);

  // New: support arbitrary audio resources (music)
  if (next.resource){
    getOrCreateGuildPlayer(conn).play(next.resource);
    return;
  }

  // Existing: TTS OGG/Opus buffers
  if (next.buffer){
    playOggOpus(conn, next.buffer);
    return;
  }

  // Fallback
  guildSpeaking.set(gid,false);
}const next=q.shift();guildQueues.set(gid,q);guildSpeaking.set(gid,true);playOggOpus(conn,next.buffer)}
async function synthesizeTTS(text,gid){const s=guildSettings.get(gid)||defaultGuildSettings();const req={input:{text},voice:createVoiceConfig(s),audioConfig:{audioEncoding:"OGG_OPUS",sampleRateHertz:48000,speakingRate:s.rate??1.0,pitch:s.pitch??0.0}};const [r]=await ttsClient.synthesizeSpeech(req);return Buffer.from(r.audioContent,"base64")}
function playOggOpus(conn,buf){const {Readable}=require("stream");const stream=Readable.from([buf]);getOrCreateGuildPlayer(conn).play(createAudioResource(stream,{inputType:StreamType.OggOpus}))}
async function speakText(conn,text){if(!text||!conn)return;const gid=conn.joinConfig.guildId;const buf=await synthesizeTTS(text,gid);const q=guildQueues.get(gid)||[];q.push({buffer:buf});guildQueues.set(gid,q);const p=getOrCreateGuildPlayer(conn);if(p.state.status==="idle"&&!guildSpeaking.get(gid))handleGuildQueue(conn)}

// -------------------- Voice connection helpers --------------------
function bindSpeakingListener(conn,ch){conn.on(VoiceConnectionStatus.Ready,()=>{logger.info(`Voice connection ready in guild ${conn.joinConfig.guildId}`);getOrCreateGuildPlayer(conn);conn.receiver.speaking.on("start",async uid=>{const gid=conn.joinConfig.guildId;if(guildSpeaking.get(gid))return;if(await isBotUser(uid))return;setupVoiceReceiver(conn,uid,ch)});});}

async function joinCurrentVoice(i){const ch=i.member?.voice?.channel;if(!ch)return replyEphemeral(i,"Join a voice channel first, then use /join.");const existing=getVoiceConnection(ch.guild.id);if(existing)return replyEphemeral(i,`Already connected to <#${existing.joinConfig.channelId}>.`);const conn=joinVoiceChannel({channelId:ch.id,guildId:ch.guild.id,adapterCreator:ch.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false});bindSpeakingListener(conn,i.channel);return replyEphemeral(i,`Joined voice: #${ch.name}. I will transcribe and speak replies.`)}

async function leaveVoice(i){const c=getVoiceConnection(i.guildId);if(!c)return replyEphemeral(i,"I am not in a voice channel.");try{c.destroy();}catch(_){}return replyEphemeral(i,"Left voice channel.")}

// -------------------- Voice pipeline --------------------
async function setupVoiceReceiver(conn,uid,ch){if(await isBotUser(uid))return;if(activeRecordings.has(uid))return;const r=conn.receiver;const pcm=path.join(__dirname,`temp_${Date.now()}_${uid}.pcm`);const ws=fsSync.createWriteStream(pcm);const start=Date.now();let sub;try{sub=r.subscribe(uid,{end:{behavior:EndBehaviorType.AfterSilence,duration:config.silenceDuration}});}catch(e){logger.error("Sub fail "+uid+": "+e.message);ws.end();return;}sub.pipe(new prism.opus.Decoder({rate:48000,channels:1,frameSize:960})).pipe(ws);activeRecordings.set(uid,{subscription:sub,writeStream:ws,startTime:start,filePath:pcm,channelId:ch.id,guildId:ch.guildId});ws.on("finish",async()=>{const dur=Date.now()-start;try{if(dur<config.minAudioDuration){logger.info("Skip short "+dur+"ms");return;}const gid=ch.guildId;const t=await transcribePCM(pcm,gid);if(!t){logger.info("Empty transcript");return;}const dn=await resolveDisplayName(ch.guild,uid);logger.info(`Transcript from ${dn} (${uid}): "${t}"`);await logToSetChannel(gid,`🗣️ [Transcript — ${dn}]: ${escapeAtAndHash(t)}`,ch);const wake=shouldTriggerWake(t,gid);if(!wake.triggered)return;if(!wake.remainder){const c=getVoiceConnection(ch.guildId);if(c)try{await speakText(c,"Yes?");}catch(e){logger.error("TTS error: "+e.message);}return;}pushHistory(ch.id,"user",wake.remainder);const ai=await getAIResponse(wake.remainder,ch.id);logger.info(`LLM reply to ${dn}: "${ai}"`);await logToSetChannel(gid,`🤖 [LLM]: ${escapeAtAndHash(ai)}`,ch);pushHistory(ch.id,"assistant",ai);const c=getVoiceConnection(ch.guildId);if(c)try{await speakText(c,ai);}catch(e){logger.error("TTS error: "+e.message);}}catch(e){logger.error("Audio error: "+e.message);}finally{activeRecordings.delete(uid);await safeUnlink(pcm);}});sub.on("error",e=>{logger.error("Sub error "+uid+": "+e.message);ws.end();});}

// -------------------- Slash commands (idempotent) --------------------
async function registerSlashCommands(){
  if (__COMMANDS_REGISTERED__) { logger.info("Slash commands already registered; skipping."); return; }
  __COMMANDS_REGISTERED__ = true;

  const join=new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel");
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

  
const play = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play audio from a URL or attachment in the current voice channel")
  .addStringOption(o => o.setName("url").setDescription("Direct link to an audio file (mp3/ogg/wav/m4a/aac)").setRequired(false))
  .addAttachmentOption(o => o.setName("attachment").setDescription("Upload an audio file").setRequired(false));

const commands=[join.toJSON(),leave.toJSON(),setchannel.toJSON(),voice.toJSON(),voicepreset.toJSON(),rate.toJSON(),pitch.toJSON(),lang.toJSON(),settings.toJSON(),wake.toJSON(),say.toJSON()
  play.toJSON(),];
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
      case "setchannel": { if(!isAdmin(i.member)) return replyEphemeral(i,"Admins only."); const ch=i.options.getChannel("channel"); if(!ch||ch.type!==ChannelType.GuildText) return replyEphemeral(i,"Please choose a text channel."); current.logChannelId=ch.id; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`Log channel set to #${ch.name}.`); }
      case "voice": { const language=i.options.getString("language"); const name=i.options.getString("name"); current.voice={languageCode:language, ssmlGender: current.voice?.ssmlGender||"NEUTRAL"}; if(name) current.voice.name=name; current.lang=language; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`Voice set: language=${language}${name?`, name=${name}`:""}`); }
      case "voicepreset": { if(!isAdmin(i.member)) return replyEphemeral(i,"Admins only."); const preset=i.options.getString("preset"); const voice=VOICE_PRESETS[preset]; if(!voice) return replyEphemeral(i,"Unknown preset"); current.voice={languageCode:voice.languageCode,name:voice.name,ssmlGender:voice.ssmlGender}; current.lang=voice.languageCode; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`Voice preset set to ${preset} -> ${voice.name}`); }
      case "rate": { const clamped=clamp(i.options.getNumber("value"),0.25,4.0); current.rate=clamped; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`Speaking rate set to ${clamped}`); }
      case "pitch": { const clamped=clamp(i.options.getNumber("value"),-20,20); current.pitch=clamped; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`Pitch set to ${clamped}`); }
      case "lang": { const code=i.options.getString("code"); current.lang=code; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`STT language set to ${code}`); }
      case "settings": return replyEphemeral(i, "Current settings: "+JSON.stringify(current));
      case "wake": { const enabled=i.options.getBoolean("enabled"); const word=i.options.getString("word")||current.wake?.word||"hey bot"; current.wake={enabled:!!enabled,word}; guildSettings.set(gid,current); await saveSettings(); return replyEphemeral(i,`Wake word ${enabled?"ENABLED":"DISABLED"}${enabled?`: "${word}"`:""}\nCurrent settings: ${JSON.stringify(current)}`); }
      case "say": { const text=i.options.getString("text"); const trimmed=String(text).trim().slice(0,500); const conn=getVoiceConnection(gid); if(!conn) return replyEphemeral(i,"I am not connected to a voice channel. Use /join first."); await deferEphemeral(i); await speakText(conn,trimmed); await i.editReply("Queued to speak."); break; }
    
      case "play": {
        const gid = i.guild?.id;
        const url = i.options.getString("url");
        const att = i.options.getAttachment("attachment");
        if (!url && !att) { await replyEphemeral(i, "Provide a direct audio URL or attach a file."); break; }

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
          const ok = /\.(mp3|ogg|oga|wav|m4a|aac)$/i.test(src || "");
          if (!ok && !att) { await i.editReply("I can only stream direct audio links (mp3/ogg/wav/m4a/aac) or file attachments."); break; }

          const resource = await createAudioResourceFromUrl(src);
          enqueueResource(conn, resource);
          const title = resource.metadata?.title || (att ? att.name : "audio");
          await i.editReply(`Queued: ${title}`);
        }catch(e){
          logger.error("Play error: " + e.message);
          await i.editReply("Could not start playback: " + e.message);
        }
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
