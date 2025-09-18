// server.js — Backend MP + Postgres (SDK v1.5.17 compatible con configure)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');

const app = express();

/* ===== Env =====
Variables necesarias en Render:
- MP_ACCESS_TOKEN
- ALLOWED_ORIGIN         (coma-separadas, ej: https://www.paupaulanguages.com,https://odoo.com)
- DATABASE_URL           (la URL de Postgres de Render)
- WEBHOOK_URL (opcional)
*/
const PORT     = process.env.PORT || 10000;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const ALLOWED  = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ===== Postgres =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.connect()
  .then(() => console.log('[DB] Conectado a Postgres ✅'))
  .catch(err => console.error('[DB] Error de conexión ❌', err));

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

// ===== Health =====
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ============================================================
   Helpers SQL de estado de reservas (sin vista materializada)
   ------------------------------------------------------------
   - 'ocupado'   => existe reserva pagada
   - 'pendiente' => existe reserva pendiente vigente (reservado_hasta > now())
   - 'disponible' => no existe nada de lo anterior
============================================================ */
const STATE_CASE = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.horario_id = h.id
        AND r.estado = 'pagado'
    ) THEN 'ocupado'
    WHEN EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.horario_id = h.id
        AND r.estado = 'pendiente'
        AND r.reservado_hasta IS NOT NULL
        AND r.reservado_hasta > now()
    ) THEN 'pendiente'
    ELSE 'disponible'
  END
`;

const DAY_ORDER = `array_position(
  ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana
)`;

// ===== 1) Listar horarios con estado =====
app.get('/horarios', async (_req, res) => {
  try {
    const q = `
      SELECT
        h.id AS horario_id,              -- 👈 ID real de la tabla horarios
        p.id AS profesor_id,
        p.nombre AS profesor,
        h.dia_semana,
        to_char(h.hora, 'HH24:MI') AS hora,
        ${STATE_CASE} AS estado
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) {
    console.error('[GET /horarios]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// ===== 2) HOLD: toma de un horario por 10 minutos =====
app.post('/hold', async (req, res) => {
  const { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!horario_id) return res.status(400).json({ error: 'bad_request', message: 'horario_id requerido' });

  try {
    await pool.query('BEGIN');

    // Verificar que NO esté pagado ni pendiente vigente
    const canQ = `
      SELECT 1
      FROM horarios h
      WHERE h.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.horario_id = h.id
            AND (
              r.estado = 'pagado' OR
              (r.estado = 'pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta > now())
            )
        )
    `;
    const can = await pool.query(canQ, [horario_id]);
    if (can.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'not_available' });
    }

    // Insertar reserva 'pendiente' por 10 minutos
    const insQ = `
      INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
      VALUES ($1, $2, $3, 'pendiente', now() + interval '10 minutes')
      RETURNING id, reservado_hasta
    `;
    const { rows } = await pool.query(insQ, [horario_id, alumno_nombre || null, alumno_email || null]);

    await pool.query('COMMIT');
    return res.json({ id: rows[0].id, reservado_hasta: rows[0].reservado_hasta });
  } catch (e) {
    await pool.query('ROLLBACK');
    if (String(e.code) === '23505') {         // índice único activo
      return res.status(409).json({ error: 'already_held' });
    }
    console.error('[POST /hold]', e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// ===== 3) RELEASE: liberar un hold pendiente =====
app.post('/release', async (req, res) => {
  const { reserva_id } = req.body || {};
  if (!reserva_id) return res.status(400).json({ error: 'bad_request', message: 'reserva_id requerido' });
  try {
    const q = `UPDATE reservas
               SET estado = 'cancelado'
               WHERE id = $1 AND estado = 'pendiente'
               RETURNING id`;
    const r = await pool.query(q, [reserva_id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_not_pending' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /release]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// ===== 4) Crear preferencia (y tomar hold si no vino antes) =====
app.post('/crear-preferencia', async (req, res) => {
  const { title, price, currency = 'ARS', back_urls = {}, metadata = {}, horario_id } = req.body || {};
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

  try {
    // Si vino horario_id sin /hold previo, intentamos tomarlo ahora
    if (horario_id) {
      try {
        await pool.query('BEGIN');
        const can = await pool.query(
          `
          SELECT 1
          FROM horarios h
          WHERE h.id = $1
            AND NOT EXISTS (
              SELECT 1 FROM reservas r
              WHERE r.horario_id = h.id
                AND (
                  r.estado = 'pagado' OR
                  (r.estado = 'pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta > now())
                )
            )
          `,
          [horario_id]
        );
        if (can.rowCount === 0) {
          await pool.query('ROLLBACK');
          return res.status(409).json({ error: 'not_available' });
        }
        await pool.query(
          `INSERT INTO reservas (horario_id, estado, reservado_hasta)
           VALUES ($1, 'pendiente', now() + interval '10 minutes')`,
          [horario_id]
        );
        await pool.query('COMMIT');
      } catch (e) {
        await pool.query('ROLLBACK');
        if (String(e.code) === '23505') {
          return res.status(409).json({ error: 'already_held' });
        }
        throw e;
      }
    }

    // Crear preferencia en MP
    const pref = {
      items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      metadata
    };
    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp && mpResp.body ? mpResp.body : mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });
  } catch (e) {
    console.error('[MP error]', e && e.message, '\n[MP error data]', e?.response?.body);
    return res.status(502).json({
      error: 'mp_failed',
      message: e?.message || 'unknown',
      details: e?.response?.body || null
    });
  }
});

// ===== 5) Webhook de pago (marca pagado) =====
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  // Ajustá según cómo te llega el webhook de MP.
  // Suponemos metadata.horario_id
  const horario_id = evento?.data?.metadata?.horario_id;

  if (evento?.type === 'payment') {
    try {
      if (horario_id) {
        const q = `
          UPDATE reservas
          SET estado = 'pagado', reservado_hasta = NULL
          WHERE horario_id = $1 AND estado = 'pendiente'
        `;
        await pool.query(q, [horario_id]);
        console.log(`[DB] Reserva confirmada para horario ${horario_id}`);
      }
    } catch (e) {
      console.error('[DB error webhook]', e);
    }
  }
  res.sendStatus(200);
});

// ===== 6) Cron: liberar holds vencidos cada minuto =====
setInterval(async () => {
  try {
    const r = await pool.query(
      `UPDATE reservas
         SET estado = 'cancelado'
       WHERE estado = 'pendiente'
         AND reservado_hasta IS NOT NULL
         AND reservado_hasta < now()`
    );
    if (r.rowCount > 0) console.log(`[cron] Reservas liberadas: ${r.rowCount}`);
  } catch (e) {
    console.error('[cron error]', e);
  }
}, 60 * 1000);

// ===== 404 =====
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
