// server.js - compatible con mercadopago v1.5.17 y CORS robusto
const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');
const bodyParser = require('body-parser');

// ===== Config MP (SDK v1) =====
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

const app = express();
app.use(bodyParser.json());

// ===== CORS robusto por ALLOWED_ORIGIN =====
// Formato de ALLOWED_ORIGIN (Render): "https://www.paupaulanguages.com,https://paupaulanguages.com,https://paupaulanguages.odoo.com"
const raw = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

// Lista exacta de Origins permitidos (string completos)
const allowListCORS = raw;

// También permitimos por hostname (p/evitar problemas con www):
const allowListHosts = raw
  .map(u => {
    try { return new URL(u).hostname; } catch { return null; }
  })
  .filter(Boolean);

// Logging útil al arrancar (lo verás en Render -> Logs)
console.log('AllowList CORS (raw): ', allowListCORS);
console.log('AllowList CORS (hosts): ', allowListHosts);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  let ok = false;

  // 1) Coincidencia exacta por Origin
  if (allowListCORS.includes(origin)) ok = true;

  // 2) Coincidencia por hostname (si vino con o sin www, etc.)
  try {
    const h = new URL(origin).hostname;
    if (allowListHosts.includes(h)) ok = true;
  } catch (_) { /* ignore */ }

  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!ok) return res.status(403).json({ error: 'cors_blocked', origin });
  next();
});

// ===== Endpoint para crear preferencia =====
app.post('/crear-preferencia', async (req, res) => {
  try {
    const {
      title,
      price,
      currency = 'ARS',
      back_urls = {},
      metadata = {}
    } = req.body || {};

    // Validaciones claras
    if (!title) return res.status(400).json({ error: 'invalid_title' });
    const unitPrice = Number(price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return res.status(400).json({ error: 'invalid_price', detail: price });
    }
    const currencyId = String(currency || '').toUpperCase();
    if (!currencyId) return res.status(400).json({ error: 'invalid_currency' });

    // back_urls deben apuntar a tu dominio .com (en el front ya mandamos base dinámico)
    const preference = {
      items: [
        { title, unit_price: unitPrice, quantity: 1, currency_id: currencyId }
      ],
      back_urls,
      auto_return: 'approved',
      metadata
    };

    const mp = await mercadopago.preferences.create(preference);
    const data = mp && mp.body ? mp.body : mp;

    if (!data || !data.init_point) {
      return res.status(502).json({ error: 'mp_failed', message: 'Sin init_point', mp_response: data });
    }

    res.json({ init_point: data.init_point });
  } catch (e) {
    // Devolvemos el motivo real para debug
    const err = {
      error: 'internal',
      message: e && e.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : e && e.stack
    };
    // Si la SDK trae más datos:
    if (e && e.cause) err.cause = e.cause;
    if (e && e.response && e.response.data) err.mp_error_data = e.response.data;
    return res.status(500).json(err);
  }
});

// (opcional) webhook
app.post('/webhook', (req, res) => {
  console.log('[webhook]', JSON.stringify(req.body));
  res.sendStatus(200);
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});


