import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

const PORT = Number(process.env.PORT || 3000);
const EVOLUTION_API_URL = String(process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = String(process.env.EVOLUTION_API_KEY || '');
const MOTAJA_AGENT_GATEWAY_SECRET = String(process.env.MOTAJA_AGENT_GATEWAY_SECRET || '');
const SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://qfdjiqacjeafquoscbnj.supabase.co').replace(/\/+$/, '');
const WEBHOOK_PATH_TOKEN = String(process.env.WEBHOOK_PATH_TOKEN || '');
const AUTO_CONFIGURE_WEBHOOK = String(process.env.AUTO_CONFIGURE_WEBHOOK || 'true') === 'true';
const INSTANCE = String(process.env.EVOLUTION_INSTANCE || 'motaja');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function clean(v, max = 1800) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function extractPhoneJid(data) {
  const key = data?.key || {};
  const alt = String(key.remoteJidAlt || '');
  const remote = String(key.remoteJid || '');
  const candidate = alt.includes('@s.whatsapp.net') ? alt : remote;
  const digits = candidate.split('@')[0].replace(/\D/g, '');
  if (!/^258\d{9}$/.test(digits)) return null;
  return { phone: `+${digits}`, jid: candidate, conversationKey: remote.includes('@lid') ? remote : `+${digits}` };
}

function unwrapMessage(message) {
  let m = message || {};
  for (let i = 0; i < 3; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else break;
  }
  return m;
}

function extractText(message) {
  const m = unwrapMessage(message);
  return clean(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    '',
  );
}

function extractLocation(message) {
  const m = unwrapMessage(message);
  const loc = m.locationMessage || m.liveLocationMessage;
  if (!loc) return null;
  const lat = Number(loc.degreesLatitude ?? loc.latitude);
  const lng = Number(loc.degreesLongitude ?? loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, address: clean(loc.address || loc.name || '', 250) || null };
}

function hasAudio(message) {
  const m = unwrapMessage(message);
  return !!m.audioMessage;
}

async function fetchAudioBase64(data) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) throw new Error('evolution_not_configured');
  const response = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(INSTANCE)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: EVOLUTION_API_KEY },
    body: JSON.stringify({ message: data }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`media_fetch_${response.status}`);
  const payload = JSON.parse(raw);
  const base64 = String(payload?.base64 || '');
  if (!base64) throw new Error('media_base64_missing');
  return { base64, mimetype: clean(payload?.mimetype || 'audio/ogg', 100) };
}

async function transcribeAudio(media) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/motaja-transcribe-audio`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-motaja-agent-secret': MOTAJA_AGENT_GATEWAY_SECRET,
    },
    body: JSON.stringify(media),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch {}
  if (!response.ok || !payload?.text) throw new Error(payload?.error || `transcribe_${response.status}`);
  return clean(payload.text, 1800);
}

async function callAgent(input) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/motaja-agent-super-entry`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-motaja-agent-secret': MOTAJA_AGENT_GATEWAY_SECRET,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(35000),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch {}
  if (!response.ok || !payload) throw new Error(`agent_${response.status}`);
  return payload;
}

async function sendText(phone, text) {
  if (!text) return;
  const number = phone.replace(/^\+/, '');
  const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(INSTANCE)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: EVOLUTION_API_KEY },
    body: JSON.stringify({ number, text: String(text).slice(0, 3800) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`send_${response.status}`);
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'motaja-whatsapp-gateway' }));

app.post('/webhook/:token', async (req, res) => {
  try {
    if (!WEBHOOK_PATH_TOKEN || !safeEqual(req.params.token, WEBHOOK_PATH_TOKEN)) return res.status(404).end();
    const body = req.body || {};
    if (body.event && body.event !== 'messages.upsert' && body.event !== 'MESSAGES_UPSERT') return res.json({ ok: true, ignored: 'event' });
    const data = body.data || {};
    if (data?.key?.fromMe === true) return res.json({ ok: true, ignored: 'from_me' });
    const remote = String(data?.key?.remoteJid || '');
    if (remote.endsWith('@g.us') || remote.includes('broadcast')) return res.json({ ok: true, ignored: 'group_or_broadcast' });
    const identity = extractPhoneJid(data);
    if (!identity) return res.json({ ok: true, ignored: 'phone' });

    let message = extractText(data.message);
    const location = extractLocation(data.message);
    if (!message && hasAudio(data.message)) {
      try {
        const media = await fetchAudioBase64(data);
        message = await transcribeAudio(media);
      } catch (error) {
        console.warn(JSON.stringify({ event: 'audio_transcription_failed', reason: String(error?.message || error).slice(0, 120) }));
        await sendText(identity.phone, 'Recebi o teu áudio, mas não consegui transcrevê-lo agora. Podes repetir em texto ou enviar outro áudio?');
        return res.json({ ok: true, audio_failed: true });
      }
    }
    if (!message && !location) return res.json({ ok: true, ignored: 'empty' });

    const agent = await callAgent({
      channel: 'whatsapp',
      conversation_key: identity.conversationKey,
      phone: identity.phone,
      message,
      location,
      metadata: { source: 'evolution', message_id: clean(data?.key?.id, 120) || null },
    });
    if (agent?.reply) await sendText(identity.phone, agent.reply);
    return res.json({ ok: true, action: agent?.action || null });
  } catch (error) {
    console.error(JSON.stringify({ event: 'webhook_error', reason: String(error?.message || error).slice(0, 160) }));
    return res.status(200).json({ ok: false });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(JSON.stringify({ event: 'gateway_started', port: PORT }));
  if (!AUTO_CONFIGURE_WEBHOOK || !EVOLUTION_API_URL || !EVOLUTION_API_KEY || !WEBHOOK_PATH_TOKEN || !process.env.RAILWAY_PUBLIC_DOMAIN) return;
  try {
    const webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/${WEBHOOK_PATH_TOKEN}`;
    const response = await fetch(`${EVOLUTION_API_URL}/webhook/set/${encodeURIComponent(INSTANCE)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] } }),
      signal: AbortSignal.timeout(15000),
    });
    console.log(JSON.stringify({ event: 'webhook_configured', status: response.status }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'webhook_config_failed', reason: String(error?.message || error).slice(0, 120) }));
  }
});
