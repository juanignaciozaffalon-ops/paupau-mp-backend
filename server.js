// server.js (SDK v2)
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// === Mercado Pago SDK v2 (CommonJS) ===
const mercadopago = require('mercadopago');
// client/config
const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

console.log('[boot] PauPau backend…');
if (!MP_ACCESS_TOKEN) {
  console.warn('[AVISO] MP_ACCESS_TOKEN no está seteado en .env');
}

// CORS
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGIN === '*' || origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error('CORS bloqueado para: ' + origin));
  }
}));
app.use(express.json());

// === Instanciar cliente y API de Preferencias (v2) ===
const mpClient = new mercadopago.MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const preferenceAPI = new mercadopago.Preference(mpClient);

// Healthcheck
app.get('/', (req, res) => res.send('PauPau MP Backend OK (v2)'));

// Crear preferencia
app.post('/crear-preferencia', async (req, res) => {
  try {
    const {
      title = 'Inscripción PauPau',
      price = 53000,
      currency = 'ARS',
      back_urls = {
        success: 'https://tu-dominio.com/pago-exitoso',
        failure: 'https://tu-dominio.com/pago-fallido',
        pending: 'https://tu-dominio.com/pago-pendiente'
      },
      metadata = {}
    } = req.body || {};

    const unit_price = Number(price);
    if (Number.isNaN(unit_price) || unit_price < 0) {
      return res.status(400).json({ error: 'Precio inválido' });
    }

    const preferenceBody = {
      items: [{ title, quantity: 1, unit_price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      notification_url: process.env.WEBHOOK_URL || undefined,
      metadata
    };

    // v2: create recibe { body: ... }
    const result = await preferenceAPI.create({ body: preferenceBody });

    // En v2 los campos vienen derechito en result
    const init_point = result.init_point || result.sandbox_init_point;
    const id = result.id;

    if (!init_point) return res.status(500).json({ error: 'No se pudo obtener init_point' });

    return res.json({ init_point, id });
  } catch (err) {
    console.error('[crear-preferencia] error:', err?.message || err);
    return res.status(500).json({ error: 'Error creando preferencia' });
  }
});

// Webhook (opcional)
app.post('/webhook', async (req, res) => {
  try {
    console.log('[webhook] body:', JSON.stringify(req.body));
    res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] error:', e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
