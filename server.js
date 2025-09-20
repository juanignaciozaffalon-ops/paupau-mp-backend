// server.js — Backend MP + Postgres + Admin Panel (profesores/horarios/estados) + Email + Multi-horarios

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();

/* ===== Env =====
Render → Settings → Environment
- MP_ACCESS_TOKEN
- ALLOWED_ORIGIN                   (ej: https://www.paupaulanguages.com,https://odoo.com)
- DATABASE_URL
- ADMIN_KEY
- (opcional) WEBHOOK_URL

SMTP (Gmail App Password):
- SMTP_HOST  (smtp.gmail.com)
- SMTP_PORT  (465)
- SMTP_USER  (paupaulanguagesadmi@gmail.com)
- SMTP_PASS  (16 chars de App Password)
- FROM_EMAIL (el mismo Gmail)
- ACADEMY_EMAIL (el mismo Gmail u otro)
*/
const PORT       = process.env.PORT || 10000;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
const ADMIN_KEY  = process.env.ADMIN_KEY || 'cambia-esta-clave';
const ALLOWED    = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

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

// ===== Mailer =====
const SMTP_HOST     = process.env.SMTP_HOST || '';
const SMTP_PORT     = Number(process.env.SMTP_PORT || 587);
const SMTP_USER     = process.env.SMTP_USER || '';
const SMTP_PASS     = process.env.SMTP_PASS || '';
const FROM_EMAIL    = process.env.FROM_EMAIL || SMTP_USER || 'no-reply@paupau.local';
const ACADEMY_EMAIL = process.env.ACADEMY_EMAIL || FROM_EMAIL;

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  transporter.verify()
    .then(() => console.log('[mail] Transporte SMTP listo ✅'))
    .catch(err => console.error('[mail] Error SMTP ❌', err?.message));
} else {
  console.warn('[mail] SMTP no configurado (saltando envío de emails)');
}

// ===== Helpers =====
const STATE_CASE = `
  CASE
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id = h.id AND r.estado = 'pagado') THEN 'ocupado'
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id = h.id AND r.estado = 'bloqueado') THEN 'bloqueado'
    WHEN EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.horario_id = h.id AND r.estado = 'pendiente'
        AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta > now()
    ) THEN 'pendiente'
    ELSE 'disponible'
  END
`;
const HAS_PAGADO = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado') AS has_pagado`;
const HAS_BLOQ   = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='bloqueado') AS has_bloqueado`;
const HAS_PEND   = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.reservado_hasta>now()) AS has_pendiente`;
const DAY_ORDER  = `array_position(ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana)`;

function sqlSlotsString(rows) {
  return rows.map(r => `${r.dia_semana} ${String(r.hora).slice(0,5)}`).join(' • ');
}

const PROF_EMAILS = {
  'Lourdes':  'paupaulanguages2@gmail.com',
  'Santiago': 'paupaulanguages10@gmail.com',
  'Milena':   'paupaulanguages13@gmail.com',
  'Gissel':   'paauutooledo@gmail.com',
  'Heliana':  'paupaulanguages9@gmail.com'
};

// ===== Health =====
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ============================================================
   PÚBLICO
============================================================ */

// Listar horarios con estado
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

// Hold manual (1 horario)
app.post('/hold', async (req, res) => {
  const { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!horario_id) return res.status(400).json({ error: 'bad_request', message: 'horario_id requerido' });

  const name  = (alumno_nombre && String(alumno_nombre).trim()) || 'N/A';
  const email = (alumno_email  && String(alumno_email).trim())  || 'noemail@paupau.local';

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
              r.estado = 'pagado'
              OR r.estado = 'bloqueado'
              OR (r.estado = 'pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta > now())
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
    const { rows } = await pool.query(insQ, [horario_id, name, email]);

    await pool.query('COMMIT');
    return res.json({ id: rows[0].id, reservado_hasta: rows[0].reservado_hasta });
  } catch (e) {
    await pool.query('ROLLBACK');
    if (String(e.code) === '23505') return res.status(409).json({ error: 'already_held' });
    console.error('[POST /hold]', e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// Crear preferencia (multi-horarios) + holds
app.post('/crear-preferencia', async (req, res) => {
  const {
    title, price, currency = 'ARS',
    back_urls = {}, metadata = {},
    horarios_ids,                     // <-- ARRAY de horario_id
    alumno_nombre, alumno_email,
    form                               // <-- objeto con todo el formulario (opcional)
  } = req.body || {};

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_request', message: 'title requerido' });
  if (typeof price !== 'number' || !(price > 0)) return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'bad_request', message: 'currency inválida' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });

  const name  = (alumno_nombre && String(alumno_nombre).trim()) || 'N/A';
  const email = (alumno_email  && String(alumno_email).trim())  || 'noemail@paupau.local';
  const ids   = Array.isArray(horarios_ids) ? horarios_ids.map(Number).filter(Boolean) : [];

  if (!ids.length) return res.status(400).json({ error: 'bad_request', message: 'horarios_ids[] requerido' });

  try {
    await pool.query('BEGIN');

    // Verificar disponibilidad de TODOS
    const canQ = `
      SELECT h.id
      FROM horarios h
      WHERE h.id = ANY($1::int[])
        AND NOT EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.horario_id = h.id
            AND (
              r.estado = 'pagado'
              OR r.estado = 'bloqueado'
              OR (r.estado = 'pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta > now())
            )
        )
    `;
    const can = await pool.query(canQ, [ids]);
    if (can.rowCount !== ids.length) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'not_available', message: 'Algún horario fue tomado' });
    }

    // Agrupar reservas con un group_ref
    const groupRef = 'grp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Insertar reservas "pendiente"
    const insQ = `
      INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta, group_ref, form_json)
      VALUES ($1, $2, $3, 'pendiente', now() + interval '10 minutes', $4, $5::jsonb)
      RETURNING id
    `;
    const createdIds = [];
    for (const hId of ids) {
      const { rows } = await pool.query(insQ, [hId, name, email, groupRef, JSON.stringify(form || {})]);
      createdIds.push(rows[0].id);
    }

    await pool.query('COMMIT');

    // Armar metadata para el pago (MUY IMPORTANTE)
    const pref = {
      items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      metadata: {
        ...metadata,
        group_ref: groupRef,
        reservas_ids: createdIds, // <-- el webhook usará esto
        alumno_nombre: name,
        alumno_email: email
      }
    };

    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      group_ref: groupRef,
      reservas_ids: createdIds
    });
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error('[crear-preferencia]', e?.message, e?.response?.body);
    return res.status(502).json({ error: 'mp_failed', message: e?.message || 'unknown', details: e?.response?.body || null });
  }
});

// Webhook (marca pagado TODOS los horarios de la compra)
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  let reservasIds = null;
  let groupRef = null;

  try {
    // MP puede no mandar metadata "plana" acá → buscamos el payment completo
    const isPayment = (evento?.type === 'payment') || (evento?.action?.includes('payment'));
    const paymentId = evento?.data?.id || evento?.data?.resource || null;

    if (isPayment && paymentId) {
      const pay = await mercadopago.payment.findById(paymentId).catch(() => null);
      const body = pay?.response || pay?.body || {};
      const meta = body?.metadata || {};
      reservasIds = Array.isArray(meta.reservas_ids) ? meta.reservas_ids.map(Number).filter(Boolean) : null;
      groupRef = meta.group_ref || null;

      if (body?.status === 'approved' || body?.status_detail?.includes('approved')) {
        try {
          await pool.query('BEGIN');

          if (reservasIds?.length) {
            await pool.query(
              `UPDATE reservas SET estado='pagado', reservado_hasta=NULL
               WHERE id = ANY($1::int[]) AND estado='pendiente'`,
              [reservasIds]
            );
          } else if (groupRef) {
            await pool.query(
              `UPDATE reservas SET estado='pagado', reservado_hasta=NULL
               WHERE group_ref=$1 AND estado='pendiente'`,
              [groupRef]
            );
          }

          await pool.query('COMMIT');

          // Enviar emails (si SMTP está configurado)
          if (transporter && (reservasIds?.length || groupRef)) {
            let rows;
            if (reservasIds?.length) {
              rows = (await pool.query(
                `SELECT r.id, r.alumno_nombre, r.alumno_email, r.form_json, p.nombre AS profesor,
                        h.dia_semana, to_char(h.hora,'HH24:MI') AS hora
                 FROM reservas r
                 JOIN horarios h ON h.id=r.horario_id
                 JOIN profesores p ON p.id=h.profesor_id
                 WHERE r.id = ANY($1::int[])`,
                [reservasIds]
              )).rows;
            } else {
              rows = (await pool.query(
                `SELECT r.id, r.alumno_nombre, r.alumno_email, r.form_json, p.nombre AS profesor,
                        h.dia_semana, to_char(h.hora,'HH24:MI') AS hora
                 FROM reservas r
                 JOIN horarios h ON h.id=r.horario_id
                 JOIN profesores p ON p.id=h.profesor_id
                 WHERE r.group_ref=$1`,
                [groupRef]
              )).rows;
            }

            if (rows.length) {
              const alumnoNombre = rows[0].alumno_nombre;
              const alumnoEmail  = rows[0].alumno_email;
              const profesorName = rows[0].profesor;
              const profesorEmail= PROF_EMAILS[profesorName] || ACADEMY_EMAIL;
              const horariosHTML = rows
                .map(r => `<li>${r.dia_semana} ${String(r.hora).slice(0,5)} hs</li>`)
                .join('');

              const form = rows[0].form_json || {};
              const formList = Object.keys(form).length
                ? ('<ul style="margin:8px 0 0 18px">' +
                   Object.entries(form)
                     .map(([k,v]) => `<li><strong>${k.replace(/_/g,' ')}:</strong> ${String(v)}</li>`).join('') +
                   '</ul>')
                : '<p>(Sin datos adicionales del formulario)</p>';

              // Mail para Academia + Profesor (CC)
              await transporter.sendMail({
                from: FROM_EMAIL,
                to: ACADEMY_EMAIL,
                cc: profesorEmail,
                subject: `Nueva inscripción confirmada: ${alumnoNombre} con ${profesorName}`,
                html: `
                  <h2>Nueva inscripción confirmada</h2>
                  <p><strong>Alumno:</strong> ${alumnoNombre} (<a href="mailto:${alumnoEmail}">${alumnoEmail}</a>)</p>
                  <p><strong>Profesor:</strong> ${profesorName} (<a href="mailto:${profesorEmail}">${profesorEmail}</a>)</p>
                  <p><strong>Horarios:</strong></p>
                  <ul style="margin:8px 0 0 18px">${horariosHTML}</ul>
                  <h3>Formulario</h3>
                  ${formList}
                `
              });

              // Mail para el Alumno
              await transporter.sendMail({
                from: FROM_EMAIL,
                to: alumnoEmail,
                subject: `¡Bienvenido/a ${alumnoNombre}! Inscripción confirmada`,
                html: `
                  <p>¡Hola ${alumnoNombre}!</p>
                  <p>¡Qué alegría que seas parte de nuestra Escuela! Bienvenido/a a PauPau Languages.</p>
                  <p>Tu docente <strong>${profesorName}</strong> te espera en clases en los siguientes horarios (hora Argentina):</p>
                  <ul style="margin:8px 0 0 18px">${horariosHTML}</ul>
                  <p>Más cerca de la fecha de inicio te enviaremos los links de acceso.</p>
                  <p>Profesor/tutor: <strong>${profesorName}</strong><br>
                  Email: <a href="mailto:${profesorEmail}">${profesorEmail}</a></p>
                  <p>¡Que tengas una excelente experiencia!<br>
                  Ana Paula Toledo Del Grosso – Founder of PauPau Languages</p>
                `
              });
            }
          }
        } catch (e) {
          await pool.query('ROLLBACK');
          console.error('[webhook DB]', e);
        }
      }
    }
  } catch (e) {
    console.warn('[webhook] error verificando payment:', e?.message);
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
   ADMIN (X-Admin-Key)
============================================================ */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Debug SMTP
app.post('/debug/send-test-email', requireAdmin, async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ error: 'smtp_not_configured' });
    const { alumnoEmail, profesorEmail } = req.body || {};
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: alumnoEmail || ACADEMY_EMAIL,
      cc: profesorEmail || undefined,
      subject: 'Prueba de correo - PauPau Languages',
      html: '<p>Esto es un test OK 👍</p>'
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[debug/send-test-email]', e);
    res.status(500).json({ error: 'send_fail', message: e?.message });
  }
});

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
             ${STATE_CASE} AS estado,
             ${HAS_PAGADO}, ${HAS_BLOQ}, ${HAS_PEND}
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

    await pool.query(`DELETE FROM horarios WHERE id = $1`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /admin/horarios/:id]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Liberar cupo (admin)
app.post('/admin/horarios/:id/liberar', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    await pool.query(
      `UPDATE reservas SET estado='cancelado'
       WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado','pagado')`,
      [id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /admin/horarios/:id/liberar]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Cambiar estado manual
app.post('/admin/horarios/:id/estado', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { estado } = req.body || {};
  if (!id || !estado) return res.status(400).json({ error: 'bad_request' });

  try {
    const paid = await pool.query(
      `SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`,
      [id]
    );
    if (paid.rowCount && estado !== 'disponible') {
      return res.status(409).json({ error: 'paid', message: 'Cupo pagado: primero usá "Liberar cupo".' });
    }

    if (estado === 'disponible') {
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
         WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado','pagado')`,
        [id]
      );
      return res.json({ ok: true });
    }

    if (estado === 'pendiente') {
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
         WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`,
        [id]
      );
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,'ADMIN','admin@paupau.local','pendiente', now() + interval '24 hours')`,
        [id]
      );
      return res.json({ ok: true });
    }

    if (estado === 'bloqueado') {
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
         WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`,
        [id]
      );
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,'ADMIN','admin@paupau.local','bloqueado', now() + interval '100 years')`,
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

// 404
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// Start
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
