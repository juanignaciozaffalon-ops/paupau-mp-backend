// server.js — Backend MP + Postgres + Admin Panel
// SDK v1.x de Mercado Pago

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');

const app = express();

/* ===== Env =====
Necesarias en Render:
- MP_ACCESS_TOKEN
- ALLOWED_ORIGIN      (coma-separadas)
- DATABASE_URL
- ADMIN_KEY
- WEBHOOK_URL (opcional)
*/
const PORT       = process.env.PORT || 10000;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
const ALLOWED    = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_KEY  = process.env.ADMIN_KEY || 'cambia-esta-clave';

// ===== CORS =====
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
   Helpers de estado
   - Ignoramos reservas canceladas
   - Orden de prioridad: pagado > bloqueado > pendiente > disponible
============================================================ */
const HAS_PAGADO = `EXISTS (
  SELECT 1 FROM reservas r
  WHERE r.horario_id = h.id AND r.estado = 'pagado'
)`;

const HAS_BLOQUEADO = `EXISTS (
  SELECT 1 FROM reservas r
  WHERE r.horario_id = h.id AND r.estado = 'bloqueado'
)`;

const HAS_PEND_24H = `EXISTS (
  SELECT 1 FROM reservas r
  WHERE r.horario_id = h.id
    AND r.estado = 'pendiente'
    AND r.reservado_hasta IS NOT NULL
    AND r.reservado_hasta > now()
)`;

const STATE_CASE = `
  CASE
    WHEN ${HAS_PAGADO}    THEN 'pagado'
    WHEN ${HAS_BLOQUEADO} THEN 'bloqueado'
    WHEN ${HAS_PEND_24H}  THEN 'pendiente'
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

// Crear preferencia (y auto-hold si vino horario_id)
app.post('/crear-preferencia', async (req, res) => {
  const { title, price, currency = 'ARS', back_urls = {}, metadata = {}, horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_request', message: 'title requerido' });
  if (typeof price !== 'number' || !(price > 0)) return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'bad_request', message: 'currency inválida' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });

  try {
    if (horario_id) {
      try {
        await pool.query('BEGIN');
        const can = await pool.query(
          `
          SELECT 1
          FROM horarios h
          WHERE h.id = $1
            AND NOT ( ${HAS_PAGADO.replace(/h\./g,'h.')} OR ${HAS_BLOQUEADO.replace(/h\./g,'h.')} OR ${HAS_PEND_24H.replace(/h\./g,'h.')} )
          `,
          [horario_id]
        );
        if (can.rowCount === 0) { await pool.query('ROLLBACK'); return res.status(409).json({ error: 'not_available' }); }
        await pool.query(
          `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
           VALUES ($1, $2, $3, 'pendiente', now() + interval '10 minutes')`,
          [horario_id, alumno_nombre || 'HOLD', alumno_email || 'hold@paupau.local']
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
      // guardamos el horario_id dentro de metadata para leerlo en el webhook
      metadata: { ...metadata, horario_id: horario_id || null }
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
  try {
    const evento = req.body || {};
    // MP manda: { action:"payment.created|... ", data:{ id } } o { type:"payment", ... }
    const isPayment = (evento?.type === 'payment') || String(evento?.action || '').startsWith('payment.');
    const paymentId = evento?.data?.id;

    let horarioIdFromMD = evento?.data?.metadata?.horario_id || null;

    if (isPayment && paymentId) {
      // buscamos el pago para extraer metadata con seguridad
      try {
        const pago = await mercadopago.payment.findById(paymentId);
        const md = pago?.body?.metadata || {};
        horarioIdFromMD = horarioIdFromMD || md.horario_id || md.horarioId || null;
      } catch (_) {}
    }

    if (horarioIdFromMD) {
      // confirmamos la reserva como pagada
      await pool.query(
        `UPDATE reservas
           SET estado = 'pagado', reservado_hasta = NULL
         WHERE horario_id = $1 AND (estado = 'pendiente' OR estado = 'bloqueado')`,
        [horarioIdFromMD]
      );
      console.log(`[Webhook] Reserva confirmada para horario ${horarioIdFromMD}`);
    }
  } catch (e) {
    console.error('[webhook error]', e);
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
             (${HAS_PAGADO})    AS has_pagado,
             (${HAS_BLOQUEADO}) AS has_bloqueado,
             (${HAS_PEND_24H})  AS has_pendiente
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

// Cambiar estado manual
app.post('/admin/horarios/:id/estado', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { estado } = req.body || {};
  if (!id || !estado) return res.status(400).json({ error: 'bad_request' });

  try {
    // si hay un pagado activo y me piden pendiente/bloqueado → 409
    const paid = await pool.query(`SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`, [id]);
    if (paid.rowCount && estado !== 'disponible') {
      return res.status(409).json({ error: 'paid', message: 'Cupo pagado: primero usá "Liberar cupo".' });
    }

    if (estado === 'disponible') {
      await pool.query(`UPDATE reservas SET estado='cancelado' WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado','pagado')`, [id]);
      return res.json({ ok: true });
    }

    if (estado === 'pendiente') {
      // cancelamos cualquier otra marca previa
      await pool.query(`UPDATE reservas SET estado='cancelado' WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`, [id]);
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,'ADMIN','admin@paupau.local','pendiente', now() + interval '24 hours')`,
        [id]
      );
      return res.json({ ok: true });
    }

    if (estado === 'bloqueado') {
      await pool.query(`UPDATE reservas SET estado='cancelado' WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`, [id]);
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,'ADMIN','admin@paupau.local','bloqueado', NULL)`,
        [id]
      );
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_request', message: 'estado inválido' });
  } catch (e) {
    console.error('[POST /admin/horarios/:id/estado]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Liberar cupo (admin): deja el horario disponible
app.post('/admin/horarios/:id/liberar', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    await pool.query(`UPDATE reservas SET estado='cancelado' WHERE horario_id=$1 AND estado IN ('pagado','pendiente','bloqueado')`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /admin/horarios/:id/liberar]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Eliminar horario (si no está pagado)
app.delete('/admin/horarios/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    const paid = await pool.query(`SELECT 1 FROM reservas WHERE horario_id = $1 AND estado = 'pagado' LIMIT 1`, [id]);
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
