// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

/* ======= CORS: permitir por host (www y sin www) ======= */
const allowListRaw = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowHosts = allowListRaw.map(v => {
  try { return new URL(v).hostname.toLowerCase(); }
  catch { return v.replace(/^https?:\/\//,'').split('/')[0].toLowerCase(); }
});

function originAllowed(origin) {
  if (!origin) return true; // curl/robots
  let host = '';
  try { host = new URL(origin).hostname.toLowerCase(); }
  catch { host = origin.replace(/^https?:\/\//,'').split('/')[0].toLowerCase(); }
  const ok = allowHosts.includes(host);
  if (!ok) console.warn('CORS bloqueado para:', origin);
  return ok;
}

app.use(cors({
  origin: (origin, cb) => originAllowed(origin) ? cb(null, true) : cb(new Error('CORS')),
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.use(express.json());

console.log('[boot] AllowList CORS (raw):', allowListRaw);
console.log('[boot] AllowList CORS (hosts):', allowHosts);

/* ======= Mercado Pago SDK v1.x ======= */
if (!process.env.MP_ACCESS_TOKEN) {
  console.error('Falta MP_ACCESS_TOKEN');
}
mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });

/* Health */
app.get('/', (_, res) => res.type('text').send('OK'));

/* ======= Crear preferencia ======= */
app.post('/crear-preferencia', async (req, res) => {
  try {
    if (!originAllowed(req.headers.origin)) {
      return res.status(403).json({ error: 'cors_blocked', origin: req.headers.origin });
    }

    const { title = 'Inscripción', price, currency = 'ARS', back_urls = {}, metadata = {} } = req.body || {};

    const unit_price = Number(price);
    if (!Number.isFinite(unit_price) || unit_price <= 0) {
      return res.status(400).json({ error: 'bad_price', message: 'price debe ser número > 0' });
    }
    const currency_id = String(currency || 'ARS').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency_id)) {
      return res.status(400).json({ error: 'bad_currency', message: 'currency debe ser código ISO de 3 letras (ej. ARS)' });
    }

    // Asegurar URLs absolutas
    const bu = {
      success: back_urls.success,
      failure: back_urls.failure,
      pending: back_urls.pending,
    };
    ['success','failure','pending'].forEach(k => {
      if (!/^https?:\/\//i.test(bu[k] || '')) bu[k] = undefined;
    });

    const payload = {
      items: [{ title, quantity: 1, unit_price, currency_id }],
      back_urls: bu,
      auto_return: 'approved',
      notification_url: process.env.WEBHOOK_URL || undefined,
      metadata
    };

    const mpResp = await mercadopago.preferences.create(payload);

    // v1.5 devuelve { response: { ... } }, pero algunos devuelven { body: { ... } }.
    const body = mpResp?.response || mpResp?.body || mpResp;
    const init_point = body?.init_point || body?.sandbox_init_point;

    if (!init_point) throw new Error('Sin init_point en la respuesta de Mercado Pago');

    res.json({ id: body?.id, init_point });
  } catch (e) {
    console.error('[mp error]', e.message, e?.response?.body || e);
    res.status(500).json({
      error: 'mp_failed',
      message: e.message || 'unknown',
      data: e?.response?.body || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});


