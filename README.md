# WhatsApp → Supabase (Edge Function) — sem n8n, sem programar

Conecte o seu WhatsApp direto a um banco de dados no **Supabase**, **sem escrever código**.
Uma **Edge Function** recebe as mensagens por webhook, **transcreve os áudios** automaticamente
com o **Groq (Whisper)** e salva tudo na tabela `whatsapp_messages`. Depois, qualquer agente de IA
lê esse banco.

> É **copiar e colar**. Todo o passo a passo é pelo painel do Supabase (Dashboard) — sem terminal, sem CLI.

```text
WhatsApp → UAZAPI (webhook) → Edge Function (Supabase) → whatsapp_messages → agente de IA
```

## O que você precisa

- Uma conta no **Supabase** (tem plano grátis) — https://supabase.com
- Uma **API de WhatsApp** já conectada. Aqui usamos a **UAZAPI**; o passo a passo de conectar
  está no **Vídeo 1** (link na descrição do vídeo).
- Uma **chave do Groq** (grátis) — https://console.groq.com

---

## Passo 1 — Criar a tabela

No Supabase, abra **SQL Editor**, cole o conteúdo de [`supabase-tabela.sql`](./supabase-tabela.sql)
e clique em **Run**.

É a mesma tabela do Vídeo 1 (`whatsapp_messages`). O comando usa `create table if not exists`,
então pode rodar de novo sem quebrar nada. Se aparecer um aviso de RLS, tudo bem — é esperado
(a tabela fica protegida; só a função escreve nela).

## Passo 2 — Pegar a chave do Groq

1. Entre em https://console.groq.com (login com Google ou GitHub).
2. Menu **API Keys** → **Create API Key** → dê um nome (ex.: `whatsapp`).
3. **Copie a chave agora** (`gsk_...`) — ela só aparece uma vez. Guarde num bloco de notas.

## Passo 3 — Criar a Edge Function

1. No Supabase, menu **Edge Functions** → **Deploy a new function** → **Via editor**.
2. Nome da função: **`whatsapp`**.
3. Apague o exemplo e **cole** o conteúdo de
   [`supabase/functions/whatsapp/index.ts`](./supabase/functions/whatsapp/index.ts).
4. **Desligue o "Verify JWT"** (é o que deixa o webhook público pra API do WhatsApp conseguir chamar).
5. Clique em **Deploy**.

## Passo 4 — Configurar a variável de ambiente (a chave do Groq)

1. Em **Edge Functions → Secrets** (Manage secrets).
2. Adicione:
   - **Nome:** `GROQ_API_KEY`
   - **Valor:** a chave `gsk_...` do Passo 2
   - **Save**
3. Pronto. Não precisa fazer deploy de novo — o secret vale na hora.

> `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são **injetados automaticamente** pelo Supabase.
> Você **não** precisa configurar essas duas.

## Passo 5 — Conectar o webhook

1. Copie a URL da sua função:
   ```text
   https://SEU_PROJECT_REF.supabase.co/functions/v1/whatsapp
   ```
2. Na **UAZAPI**, vá na sua instância → **Configurar webhook** → cole essa URL.
3. Marque os eventos: **mensagens**, **mensagem update**, **grupos**, **chats**. (QR code / conexão: não.)
4. Salve.

### 🔒 Segurança — a URL é a sua senha

Esta função fica **aberta** (sem segredo) pra ser simples de montar. Isso significa que **quem tiver
a URL consegue enviar dados pra ela**. Então:

- **Não compartilhe/poste a URL do seu webhook** em lugar nenhum. Trate como senha.
- **Se a URL vazar, rotacione:** renomeie a função (nome novo = URL nova) e atualize o webhook na
  UAZAPI. A URL antiga para de funcionar na hora.
- Quer uma trava a mais? Veja [Segurança avançada](#segurança-avançada-opcional).

## Testar

Mande uma mensagem de **texto** para o número conectado e veja cair em
**Table Editor → whatsapp_messages**. Depois mande um **áudio**: em 1–2 segundos a coluna
`transcription` deve aparecer com o texto do que foi falado.

Deu ruim? Veja **Edge Functions → Logs** — cada chamada, erro e o formato exato que sua API mandou.

---

## O que a função trata

Texto, **áudio (transcrito)**, imagem, vídeo, documento, sticker, reação, resposta (reply),
edição e deleção — em conversa de **grupo** e **privada**, tanto **recebida** quanto **enviada**.
Salva com `upsert` por `message_id` (não duplica se a API reenviar o evento).

O áudio do WhatsApp vem **criptografado** (`.enc`); a função **descriptografa** internamente
(a partir do `mediaKey`) antes de mandar pro Groq. Só baixa mídia de hosts do WhatsApp
(`*.whatsapp.net`) — trava contra SSRF.

## Variáveis opcionais

Todas com padrão sensato; só mexa se precisar.

- `WHATSAPP_OWNER` — seu número (o payload já traz; só fallback).
- `MEDIA_ALLOWED_HOSTS` — hosts extras de onde baixar mídia (CSV). Padrão: `*.whatsapp.net`.
- `MAX_AUDIO_SECONDS` — pula áudios acima de X segundos. Padrão: `0` (sem limite).
- `AUDIO_TIMEOUT_MS` — timeout do download do áudio. Padrão: `20000`.
- `MAX_AUDIO_BYTES` — teto do arquivo de áudio. Padrão: `26214400` (25 MB).

## Segurança avançada (opcional)

Se quiser exigir um segredo em vez de confiar só na URL: gere um `WEBHOOK_SECRET`, adicione como
secret, e no início da função rejeite requisições cujo header `x-webhook-secret` (ou `?secret=`
na URL) não bata. Configure o header no webhook da UAZAPI. Isso troca "URL secreta" por
"segredo de verdade" — recomendado pra uso em produção séria.

## ⚠️ Uso responsável

- **Não** use API não-oficial de WhatsApp para **disparo em massa** — risco alto de ban.
  Aqui a gente só **escuta** conversas que já existem.
- Este código é **ponto de partida**, validado com a **UAZAPI** (formato whatsmeow). Outro
  provedor manda o payload diferente — confira o JSON real em **Edge Functions → Logs** e ajuste.
- Cuidado com **dados pessoais**: você está guardando conversas reais. Trate o banco com o cuidado
  que esse dado merece.
