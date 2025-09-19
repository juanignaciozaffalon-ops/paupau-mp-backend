// server.js — Backend MP + Postgres + Admin Panel
// SDK v1.5.x de Mercado Pago (compatible con configure)

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');

const app = express();

/* ===== Env =====
Variables necesarias en Render:
- MP_ACCESS_TOKEN
- ALLOWED_ORIGIN   (coma-separadas, ej: https://www.paupaulanguages.com,https://odoo.com)
- DATABASE_URL
- ADMIN_KEY        (clave simple para el panel admin)
- WEBHOOK_URL      (opcional)
*/
const PORT       = process.env.PORT || 10000;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
const ALLOWED    = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_KEY  = process.env.ADMIN_KEY || 'cambia-esta-clave';

// ===== CORS mínimo =====
app.use((req, res, next) => {
  const reqOrigin = req.headers.origin || '';
  const ok = ALLOWED.includes(reqOrigin);
  if (ok) {
    res.header('Access-Control-Allow-Origin', reqOrigin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(ok ? 200 : 403);
  next();
});

app.use(bodyParser.json());

// ===== Postgres =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.connect()
  .then(() => console.log('[DB] Conectado a Postgres ✅'))
  .catch(err => console.error('[DB] Error de conexión ❌', err));

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
   Helpers SQL de estado de reservas
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

/* ============================================================
   PÚBLICO
============================================================ */

// Listar horarios con estado (para el formulario)
app.get('/horarios', async (_req, res) => {
  try {
    const q = `
      SELECT
        h.id AS horario_id,
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

// Hold por 10 minutos
app.post('/hold', async (req, res) => {
  let { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!horario_id) return res.status(400).json({ error: 'bad_request', message: 'horario_id requerido' });

  // 👇 Defaults para cumplir NOT NULL en tu tabla
  alumno_nombre = (alumno_nombre || '').trim() || 'Web';
  alumno_email  = (alumno_email  || '').trim() || 'sin-email@paupaulanguages';

  try {
    await pool.query('BEGIN');

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

    const insQ = `
      INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
      VALUES ($1, $2, $3, 'pendiente', now() + interval '10 minutes')
      RETURNING id, reservado_hasta
    `;
    const { rows } = await pool.query(insQ, [horario_id, alumno_nombre, alumno_email]);

    await pool.query('COMMIT');
    return res.json({ id: rows[0].id, reservado_hasta: rows[0].reservado_hasta });
  } catch (e) {
    await pool.query('ROLLBACK');
    if (String(e.code) === '23505') return res.status(409).json({ error: 'already_held' });
    console.error('[POST /hold]', e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// Release
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

// Crear preferencia (y auto-hold si vino horario_id)
app.post('/crear-preferencia', async (req, res) => {
  let { title, price, currency = 'ARS', back_urls = {}, metadata = {}, horario_id,
        alumno_nombre, alumno_email } = req.body || {};

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_request', message: 'title requerido' });
  if (typeof price !== 'number' || !(price > 0)) return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'bad_request', message: 'currency inválida' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });

  // 👇 Defaults para cumplir NOT NULL
  alumno_nombre = (alumno_nombre || '').trim() || 'Web';
  alumno_email  = (alumno_email  || '').trim() || 'sin-email@paupaulanguages';

  try {
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
        if (can.rowCount === 0) { await pool.query('ROLLBACK'); return res.status(409).json({ error: 'not_available' }); }
        await pool.query(
          `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
           VALUES ($1, $2, $3, 'pendiente', now() + interval '10 minutes')`,
          [horario_id, alumno_nombre, alumno_email]
        );
        await pool.query('COMMIT');
      } catch (e) {
        await pool.query('ROLLBACK');
        if (String(e.code) === '23505') return res.status(409).json({ error: 'already_held' });
        throw e;
      }
    }

    const pref = {
      items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      metadata
    };
    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });
  } catch (e) {
    console.error('[MP error]', e?.message, '\n[MP error data]', e?.response?.body);
    return res.status(502).json({ error: 'mp_failed', message: e?.message || 'unknown', details: e?.response?.body || null });
  }
});

// Webhook (marca pagado)
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  // Ajustar al shape real si fuese necesario:
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

// Cron: liberar holds vencidos
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

/* ============================================================
   ADMIN (protegido con X-Admin-Key)
============================================================ */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---- Profesores ----
app.get('/admin/profesores', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, nombre FROM profesores ORDER BY nombre`);
    res.json(rows);
  } catch (e) {
    console.error('[GET /admin/profesores]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/admin/profesores', requireAdmin, async (req, res) => {
  const { nombre } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'bad_request', message: 'nombre requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO profesores (nombre) VALUES ($1) RETURNING id, nombre`,
      [String(nombre).trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[POST /admin/profesores]', e);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/admin/profesores/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    const used = await pool.query(`SELECT 1 FROM horarios WHERE profesor_id = $1 LIMIT 1`, [id]);
    if (used.rowCount) return res.status(409).json({ error: 'in_use', message: 'El profesor tiene horarios' });
    await pool.query(`DELETE FROM profesores WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /admin/profesores/:id]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// ---- Horarios ----
app.get('/admin/horarios', requireAdmin, async (req, res) => {
  const profesor_id = Number(req.query.profesor_id) || null;
  try {
    const params = [];
    let where = '';
    if (profesor_id) { where = 'WHERE h.profesor_id = $1'; params.push(profesor_id); }
    const q = `
      SELECT h.id, h.profesor_id, p.nombre AS profesor, h.dia_semana, to_char(h.hora,'HH24:MI') AS hora,
             ${STATE_CASE} AS estado
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ${where}
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error('[GET /admin/horarios]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/admin/horarios', requireAdmin, async (req, res) => {
  const { profesor_id, dia_semana, hora } = req.body || {};
  if (!profesor_id || !dia_semana || !hora) {
    return res.status(400).json({ error: 'bad_request', message: 'profesor_id, dia_semana, hora requeridos' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO horarios (profesor_id, dia_semana, hora)
       VALUES ($1, $2, $3::time) RETURNING id, profesor_id, dia_semana, to_char(hora,'HH24:MI') AS hora`,
      [profesor_id, dia_semana, hora]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[POST /admin/horarios]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/admin/horarios/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    const paid = await pool.query(
      `SELECT 1 FROM reservas WHERE horario_id = $1 AND estado = 'pagado' LIMIT 1`,
      [id]
    );
    if (paid.rowCount) return res.status(409).json({ error: 'paid', message: 'No puede eliminarse: ya está pagado' });

    await pool.query(`DELETE FROM horarios WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /admin/horarios/:id]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// ===== 404 =====
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
