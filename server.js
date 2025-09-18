// server.js — Backend MP (SDK v1.5.17 compatible con configure)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');

const app = express();

// ===== Env =====
// En Render: MP_ACCESS_TOKEN, ALLOWED_ORIGIN (coma-separadas), WEBHOOK_URL (opcional)
const PORT = process.env.PORT || 10000;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const ALLOWED = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Log útil al arrancar
console.log('[boot] Allowed CORS (env):', ALLOWED);

// ===== CORS =====
app.use((req, res, next) => {
  const reqOrigin = req.headers.origin || '';
  const ok = ALLOWED.includes(reqOrigin);
  if (ok) {
    res.header('Access-Control-Allow-Origin', reqOrigin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(ok ? 200 : 403);
  next();
});

app.use(bodyParser.json());

// ===== MP SDK v1.x =====
try {
  mercadopago.configure({ access_token: MP_TOKEN });
  console.log('[boot] Mercado Pago SDK configurado (v1.x)');
} catch (e) {
  console.error('[boot] Error configurando MP SDK:', e.message);
}

// ===== Rutas =====
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/crear-preferencia', async (req, res) => {
  const { title, price, currency = 'ARS', back_urls = {}, metadata = {} } = req.body || {};
  // Validaciones básicas
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'title requerido (string)' });
  }
  if (typeof price !== 'number' || !(price > 0)) {
    return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: 'bad_request', message: 'currency debe ser ISO 4217 (p.ej. ARS)' });
  }
  if (!MP_TOKEN) {
    return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });
  }

  const pref = {
    items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
    back_urls,
    auto_return: 'approved',
    metadata,
  };

  try {
    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp && mpResp.body ? mpResp.body : mpResp;
    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
    });
  } catch (e) {
    // Log bien claro para Render
    console.error('[MP error]', e && e.message, '\n[MP error data]', e && e.response && e.response.body);
    return res.status(502).json({
      error: 'mp_failed',
      message: e && e.message || 'unknown',
      details: e && e.response && e.response.body || null,
    });
  }
});
// ===== RUTA HORARIOS =====
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/horarios', async (req, res) => {
  try {
    const query = `
      SELECT p.nombre, h.dia_semana, to_char(h.hora, 'HH24:MI') as hora
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ORDER BY p.nombre,
        array_position(ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana),
        h.hora;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('[DB error]', err.message);
    res.status(500).json({ error: 'db_failed', message: err.message });
  }
});

// ===== 404 =====
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
