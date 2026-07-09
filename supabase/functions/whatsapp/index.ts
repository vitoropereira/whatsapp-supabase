// ============================================================
// Edge Function: whatsapp
// Recebe o webhook da UAZAPI, trata a mensagem, transcreve áudio
// (Groq Whisper) e salva na tabela whatsapp_messages.
//
// Deploy pelo Dashboard: Edge Functions -> nova função "whatsapp"
//   -> cola este arquivo -> Verify JWT OFF -> Deploy.
//
// Secrets (Edge Functions -> Secrets):
//   GROQ_API_KEY    (obrigatório p/ transcrever áudio)
//   WHATSAPP_OWNER  (opcional: o payload já traz o dono; só fallback)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados pelo Supabase.
//
// ⚠️ SEGURANÇA — endpoint SEM segredo: a URL é a sua "senha".
//   Quem tiver a URL consegue gravar nesta tabela. A proteção é o trecho
//   aleatório do seu projeto na URL (o SEU_PROJECT_REF). Portanto:
//     • NÃO publique/comite/mostre a URL do seu webhook.
//     • Se ela vazar, ROLE: renomeie a função (novo slug = nova URL) e
//       atualize o webhook na UAZAPI. Aí a URL antiga morre.
//   O download de mídia continua travado por allowlist de host (anti-SSRF).
//
// Mapeamento validado contra payloads reais da UAZAPI (formato whatsmeow):
//   tudo em payload.message; mídia em message.content; áudio criptografado
//   (.enc) -> descriptografado aqui com o mediaKey antes de ir pro Groq.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const OWNER_FALLBACK = Deno.env.get("WHATSAPP_OWNER") ?? "";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
// 0 = sem limite. Ex.: 600 pula áudios com mais de 10 min.
const MAX_AUDIO_SECONDS = Number(Deno.env.get("MAX_AUDIO_SECONDS") ?? "0");

// Anti-SSRF: só baixamos mídia de hosts do WhatsApp. A URL vem do payload,
// então sem isso um webhook autenticado poderia apontar pra rede interna.
// Override opcional (hosts exatos, separados por vírgula) se seu provedor
// servir mídia de outro domínio.
const MEDIA_ALLOWED_HOSTS = (Deno.env.get("MEDIA_ALLOWED_HOSTS") ?? "")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const AUDIO_TIMEOUT_MS = Number(Deno.env.get("AUDIO_TIMEOUT_MS") ?? "20000");
const MAX_AUDIO_BYTES = Number(Deno.env.get("MAX_AUDIO_BYTES") ?? String(25 * 1024 * 1024));

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  // 0) Webhook só aceita POST.
  if (req.method !== "POST") return text("method not allowed", 405);

  // Endpoint sem segredo (ver cabeçalho): a proteção é a URL não vazar.
  let payload: Any;
  try {
    payload = await req.json();
  } catch {
    return text("bad request", 400);
  }

  const eventType = String(payload.EventType ?? payload.event ?? payload.type ?? "");

  // 2) Deleção chega como "messages_update" com Type=Deleted -> marca is_deleted.
  if (eventType === "messages_update") {
    await handleDeletion(payload);
    return text("ok", 200);
  }

  // 3) Só mensagens novas são salvas. groups/chats/status são ignorados.
  if (eventType !== "messages") return text("ignored", 200);

  const m: Any = payload.message ?? {};
  const row = buildRow(payload, m);
  if (!row.message_id) return text("no message_id", 200);

  // 4) Áudio -> descriptografa e transcreve. Falha aqui não derruba o salvamento.
  if (row.message_type === "audio") {
    try {
      const transcription = await transcribeAudio(m);
      if (transcription) {
        row.transcription = transcription;
        row.message = transcription;
      }
    } catch (e) {
      console.error("transcription failed:", errMsg(e));
    }
  }

  // 5) Salva. SERVICE_ROLE ignora RLS. upsert por message_id = idempotente.
  const { error } = await supabase
    .from("whatsapp_messages")
    .upsert(row, { onConflict: "message_id" });
  if (error) {
    console.error("upsert error:", error.message);
    return text("db error", 500);
  }
  return json({ ok: true, message_id: row.message_id });
});

// ---------- montagem da linha ----------

function buildRow(payload: Any, m: Any) {
  const isGroup = Boolean(m.isGroup);
  const fromMe = Boolean(m.fromMe);
  const owner = onlyDigits(payload.owner ?? m.owner ?? OWNER_FALLBACK) || "unknown";

  const chatId = stripJid(m.chatid);
  const senderPhone = stripJid(m.sender_pn ?? m.sender) ?? "unknown";
  const contactPhone = isGroup ? null : chatId;
  const recipientPhone = isGroup ? null : (fromMe ? chatId : owner);

  const isReaction = m.messageType === "ReactionMessage" || m.type === "reaction";
  const type = normalizeType(m);

  const content = m.content;
  const c: Any = (content && typeof content === "object" && !Array.isArray(content))
    ? content
    : {};
  const contentStr = typeof content === "string" ? content : null;

  // Texto: Conversation -> content é string; ExtendedText -> content.text; senão m.text.
  const bodyText = strOrNull(m.text) ?? strOrNull(c.text) ?? contentStr;
  const caption = strOrNull(c.caption);

  return {
    whatsapp_owner: owner,
    chat_type: isGroup ? "group" : "private",
    chat_id: chatId,
    chat_name: isGroup ? strOrNull(m.groupName) : null,
    contact_phone: contactPhone,
    sender_phone: senderPhone,
    sender_name: strOrNull(m.senderName),
    recipient_phone: recipientPhone,
    direction: fromMe ? "outbound" : "inbound",
    message_type: isReaction ? "reaction" : type,
    message: isReaction ? null : (bodyText ?? caption),
    caption,
    media_url: strOrNull(c.URL ?? c.url),
    media_mime_type: strOrNull(c.mimetype ?? c.mimeType),
    media_file_name: strOrNull(c.fileName ?? c.title),
    media_sha256: strOrNull(c.fileSHA256),
    media_size_bytes: numOrNull(c.fileLength ?? c.size),
    transcription: null as string | null,
    message_id: strOrNull(m.messageid ?? m.id),
    external_message_id: strOrNull(m.id),
    reply_to_message_id: strOrNull(m.quoted),
    is_edited: Boolean(strOrNull(m.edited)),
    reaction: isReaction ? strOrNull(m.text ?? c.text) : null,
    reacted_to_message_id: isReaction
      ? (strOrNull(m.reaction) ?? strOrNull(c?.key?.ID))
      : null,
    status: mapStatus(m.status),
    message_created_at: msToIso(m.messageTimestamp) ?? nowIso(),
    metadata: payload,
  };
}

async function handleDeletion(payload: Any) {
  const upd = payload.event;
  if (!upd || typeof upd !== "object") return;
  if (upd.Type !== "Deleted" || !Array.isArray(upd.MessageIDs)) return;
  const ids = upd.MessageIDs.map((x: unknown) => String(x)).filter(Boolean);
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("whatsapp_messages")
    .update({ is_deleted: true, deleted_at: nowIso() })
    .in("message_id", ids);
  if (error) console.error("deletion update error:", error.message);
}

// ---------- áudio: descriptografia + transcrição ----------

const MEDIA_APP_INFO: Record<string, string> = {
  audio: "WhatsApp Audio Keys",
  ptt: "WhatsApp Audio Keys",
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  document: "WhatsApp Document Keys",
};

async function transcribeAudio(m: Any): Promise<string | null> {
  if (!GROQ_API_KEY) {
    console.error("GROQ_API_KEY ausente — pulei a transcrição");
    return null;
  }
  const c: Any = (m.content && typeof m.content === "object") ? m.content : {};
  const encUrl = strOrNull(c.URL ?? c.url);
  const mediaKey = strOrNull(c.mediaKey);
  const mime = strOrNull(c.mimetype) ?? "audio/ogg";
  if (!encUrl || !mediaKey) {
    console.error("áudio sem URL/mediaKey — pulei a transcrição");
    return null;
  }
  if (MAX_AUDIO_SECONDS > 0 && Number(c.seconds) > MAX_AUDIO_SECONDS) {
    console.warn("áudio maior que MAX_AUDIO_SECONDS — pulei");
    return null;
  }

  const audio = await decryptWhatsAppMedia(encUrl, mediaKey, "audio");

  const form = new FormData();
  form.append("file", new File([audio], "audio.ogg", { type: mime.split(";")[0] }));
  form.append("model", GROQ_MODEL);
  form.append("language", "pt");
  form.append("response_format", "json");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (String(data?.text ?? "").trim()) || null;
}

function isAllowedMediaHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (MEDIA_ALLOWED_HOSTS.length > 0) return MEDIA_ALLOWED_HOSTS.includes(h);
  return h === "whatsapp.net" || h.endsWith(".whatsapp.net");
}

// Baixa a mídia .enc com trava anti-SSRF: https-only, host na allowlist,
// sem seguir redirect (um 302 poderia pivotar pra rede interna), com timeout
// e teto de bytes.
async function fetchEncryptedMedia(rawUrl: string): Promise<Uint8Array<ArrayBuffer>> {
  const u = new URL(rawUrl);
  if (u.protocol !== "https:") throw new Error("media url must be https");
  if (!isAllowedMediaHost(u.hostname)) {
    throw new Error(`media host not allowed: ${u.hostname}`);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUDIO_TIMEOUT_MS);
  try {
    // redirect:"manual" -> 3xx vira resposta opaca (status 0, ok=false) e cai no throw.
    const res = await fetch(u, { redirect: "manual", signal: ctrl.signal });
    if (!res.ok) throw new Error(`media download blocked/failed: ${res.status}`);
    if (Number(res.headers.get("content-length") ?? "0") > MAX_AUDIO_BYTES) {
      throw new Error("audio too large");
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_AUDIO_BYTES) throw new Error("audio too large");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// Mídia do WhatsApp é criptografada (AES-256-CBC).
// Chaves derivadas do mediaKey via HKDF-SHA256, info por tipo de mídia.
// O arquivo .enc = ciphertext || mac(10 bytes) -> corta o mac antes de decifrar.
async function decryptWhatsAppMedia(
  encUrl: string,
  mediaKeyB64: string,
  mediaType: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const appInfo = MEDIA_APP_INFO[mediaType] ?? MEDIA_APP_INFO.audio;
  const mediaKey = b64ToBytes(mediaKeyB64);

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    mediaKey,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // salt nulo = 32 zeros (RFC 5869)
      info: new TextEncoder().encode(appInfo),
    },
    hkdfKey,
    112 * 8,
  );
  const expanded = new Uint8Array(bits);
  const iv = expanded.slice(0, 16);
  const cipherKey = expanded.slice(16, 48);

  const enc = await fetchEncryptedMedia(encUrl);
  if (enc.length <= 10) throw new Error("media file too small");
  const ciphertext = enc.slice(0, enc.length - 10); // corta os 10 bytes de MAC

  const key = await crypto.subtle.importKey(
    "raw",
    cipherKey,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext);
  return new Uint8Array(plain);
}

// ---------- helpers ----------

// deno-lint-ignore no-explicit-any
type Any = any;

function normalizeType(m: Any): string {
  const mt = String(m.mediaType ?? "").toLowerCase();
  if (mt === "ptt" || mt === "audio") return "audio";
  if (mt === "image") return "image";
  if (mt === "video") return "video";
  if (mt === "document") return "document";
  if (mt === "sticker") return "sticker";
  const t = String(m.messageType ?? "").toLowerCase();
  if (t.includes("audio")) return "audio";
  if (t.includes("image")) return "image";
  if (t.includes("video")) return "video";
  if (t.includes("document")) return "document";
  if (t.includes("sticker")) return "sticker";
  return "text";
}

function mapStatus(s: unknown): string {
  const v = String(s ?? "").toLowerCase();
  const map: Record<string, string> = {
    queued: "pending",
    pending: "pending",
    sent: "sent",
    delivered: "delivered",
    read: "read",
    played: "read",
    failed: "failed",
    error: "failed",
  };
  return map[v] ?? "sent";
}

function msToIso(ts: unknown): string | null {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n; // segundos -> ms
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function stripJid(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const s = v.split("@")[0].split(":")[0].trim();
  return s || null;
}

function onlyDigits(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
