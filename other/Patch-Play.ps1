
# Patch-Play.ps1
param(
  [Parameter(Mandatory=$true)]
  [string]$Path
)

$code = Get-Content -Raw -Path $Path

# 1) Normalize safeUnlink to a good async version
# Remove any existing definitions (a few variants) and inject a clean one just once.
$code = [regex]::Replace($code, '(?s)(?:async\s+)?function\s+safeUnlink\s*\([^)]*\)\s*\{.*?\}\s*', '', 10)

$safeUnlink = @"
// ---- File helper (fixed) ----
async function safeUnlink(f) {
  try {
    await fs.unlink(f);
  } catch (e) {
    // ignore missing file or unlink errors
  }
}
"@

if($code -match '// ---- Music helpers'){
  $code = $code -replace [regex]::Escape('// ---- Music helpers'), "$safeUnlink`r`n// ---- Music helpers"
}else{
  # Try to insert after @discordjs/voice require line as fallback
  $code = $code -replace '(\}\s*=\s*require\("@discordjs/voice"\);\s*)', "`$1`r`n$safeUnlink`r`n"
}

# 2) Remove stray/dangling catch{} tokens that sometimes appear after a block
$code = $code -replace '\}\s*catch\s*\{\s*\}\s*\}', '}}'
$code = $code -replace '(\})\s*catch\s*\{\s*\}\s*(\})', '$1$2'

# 3) Ensure StreamType is imported from @discordjs/voice
$code = [regex]::Replace(
  $code,
  'const\s*\{\s*([^}]*)\}\s*=\s*require\("@discordjs/voice"\);',
  {
    param($m)
    $items = ($m.Groups[1].Value -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    if(-not ($items -contains 'StreamType')){ $items += 'StreamType' }
    $unique = $items | Select-Object -Unique
    "const { {0} } = require(""@discordjs/voice"");" -f ($unique -join ', ')
  },
  1
)

# 4) Insert Music helpers if missing
if($code -notmatch 'function\s+createAudioResourceFromUrl'){
  $helpers = @"
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
}
"@
  if($code -match '// ---- File helper \(fixed\) ----'){
    $code = $code -replace [regex]::Escape('// ---- File helper (fixed) ----'), "// ---- File helper (fixed) ----`r`n$helpers"
  } elseif($code -match '// ---- Music helpers'){
    # Already present label; prepend helpers right after
    $code = $code -replace [regex]::Escape('// ---- Music helpers'), "// ---- Music helpers`r`n$helpers"
  } else {
    $code = $helpers + "`r`n" + $code
  }
}

# 5) Replace handleGuildQueue implementation
$hqNew = @"
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
}
"@

$code = [regex]::Replace($code, '(?s)function\s+handleGuildQueue\s*\([^)]*\)\s*\{.*?\}', $hqNew, 1)

# 6) Add /play builder and include in commands array
if($code -notmatch '\bconst\s+play\s*=\s*new\s+SlashCommandBuilder\('){
  $playBuilder = @"
const play = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play audio from a URL or attachment in the current voice channel")
  .addStringOption(o => o.setName("url").setDescription("Direct link to an audio file (mp3/ogg/wav/m4a/aac)").setRequired(false))
  .addAttachmentOption(o => o.setName("attachment").setDescription("Upload an audio file").setRequired(false));
"@
  # Insert before commands array
  $code = $code -replace 'const\s+commands\s*=\s*\[', "$playBuilder`r`nconst commands = ["
}

# Ensure play.toJSON() in commands
if($code -match 'const\s+commands\s*=\s*\[([^\]]*)\]'){
  $inside = $matches[1]
  if($inside -notmatch 'play\.toJSON\(\)'){
    $code = $code -replace 'const\s+commands\s*=\s*\[([^\]]*)\]', { "const commands = [$($args[0].Groups[1].Value), play.toJSON()]" }
  }
}

# 7) Insert "case \"play\"" in the interaction switch
if($code -notmatch 'case\s+"play"\s*:'){
  $playCase = @"
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
"@

  # Find switch(i.commandName){ and insert before its closing brace
  $switchStart = [regex]::Match($code, 'switch\s*\(\s*i\.commandName\s*\)\s*\{')
  if($switchStart.Success){
    # We do a simple text-based find of the matching brace by counting
    $startIdx = $switchStart.Index + $switchStart.Length - 1
    $depth = 0
    $i = $startIdx
    while($i -lt $code.Length){
      $ch = $code[$i]
      if($ch -eq '{'){ $depth++ }
      elseif($ch -eq '}'){
        $depth--
        if($depth -eq 0){ break }
      }
      $i++
    }
    if($i -lt $code.Length){
      $code = $code.Insert($i, "`r`n$playCase`r`n")
    }
  }
}

# 8) Write out .fixed.js next to the original
$outPath = [System.IO.Path]::ChangeExtension($Path, ".fixed.js")
Set-Content -Path $outPath -Value $code -NoNewline
Write-Host "Patched file written to $outPath"
