# Oracle VoiceBot

A Discord voice bot that listens in voice channels, responds using **OpenAI’s GPT models**, and speaks replies using **Google Cloud Text-to-Speech**.  

It also plays a short **“thinking” sound** while preparing a reply.

---

## ✨ Features
- **Wake word detection** – responds when the trigger word (default: `oracle`) is the first, second, or last word in a transcript.  
- **LLM-powered answers (OpenAI)** – text responses generated via OpenAI Chat Completions.  
- **Voice replies (Google Cloud TTS)** – converts replies to natural speech in Opus/Ogg.  
- **Thinking sound effect** – plays `thinking.ogg` (or `thinking.mp3`) while preparing.  
- **Slash commands** – configure voices, presets, and thinking sound toggle.

---

## 📦 Requirements
- Node.js **v22+**
- `ffmpeg` installed (needed if you only have MP3 thinking sound)
- **Discord bot token**
- **OpenAI API key**
- **Google Cloud service account JSON** with Text-to-Speech enabled

---

## ⚙️ Setup

1. **Clone repo**
   ```bash
   git clone <your-repo-url>
   cd <repo>
````

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Add your environment variables**
   Copy `.env.example` → `.env` and edit it:

   ```bash
   cp .env.example .env
   ```

4. **Thinking sound**
   Place a `thinking.ogg` in the bot folder. If you only have MP3, put `thinking.mp3` there; the bot will transcode it with ffmpeg.

   Convert the BBC sample once into OGG:

   ```bash
   ffmpeg -y -i "https://sound-effects-media.bbcrewind.co.uk/mp3/07042083.mp3" \
     -vn -c:a libopus -b:a 96k -ar 48000 -ac 2 thinking.ogg
   ```

---

## ▶️ Running

```bash
node bot.thinking.local.js
```

Expected logs:

```
[info] Thinking hook: wake triggered
[info] Thinking sound: using local thinking.ogg
[info] Thinking sound: playing (local)
[info] Thinking sound: interrupted before TTS
```

---

## 🔊 Usage

* Join a voice channel with the bot.
* Example query:

  > “**Oracle**, what do you think about trees?”
* Bot plays the thinking sound, sends the query to OpenAI, and speaks the reply via Google Cloud TTS.

---

## ⌨️ Slash Commands

The bot provides several slash commands for live configuration inside Discord:

### `/voice`

Set a custom voice configuration for Google TTS. Example:

```
/voice languageCode: en-US name: en-US-Neural2-D ssmlGender: MALE
```

### `/voicepreset`

Pick from pre-defined presets. Example:

```
/voicepreset preset: en-US:male
```

Available presets include:

* `en-US:male`
* `en-US:female`
* `en-GB:male`
* `en-GB:female`

### `/trigger enable`

Enable the thinking sound.

### `/trigger disable`

Disable the thinking sound.

### `/trigger url <url>`

Set a custom URL for the thinking sound.

---

## 🛠 Troubleshooting

* **No audio** – check bot’s volume in Discord, confirm `thinking.ogg` exists.
* **Silent thinking sound** – make sure `ffmpeg -version` works in your terminal.
* **No TTS output** – verify Google service account JSON and API enablement.
* **No replies** – confirm `OPENAI_API_KEY` is valid and not rate-limited.

---

## 📄 License

MIT (or your choice)

---

# `.env.example`

```env
# Discord bot token
DISCORD_TOKEN=your_discord_bot_token

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Google Cloud
# Path to your service account JSON file with Text-to-Speech enabled
GOOGLE_APPLICATION_CREDENTIALS=./service_account.json
```

