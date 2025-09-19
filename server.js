// server.js — Backend MP + Postgres + Admin Panel + Emails (multi-horario)
// SDK v1.x de Mercado Pago

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();

/* ===== Env (Render → Settings → Environment) =====
Obligatorias:
- MP_ACCESS_TOKEN
- DATABASE_URL
- ALLOWED_ORIGIN           (coma-separadas, ej: https://www.paupaulanguages.com,https://odoo.com)
- ADMIN_KEY

Email (SMTP Gmail App Password):
- SMTP_HOST        (smtp.gmail.com)
- SMTP_PORT        (465)
- SMTP_USER        (paupaulanguagesadmi@gmail.com)
- SMTP_PASS        (App Password 16 chars, SIN espacios)
- FROM_EMAIL       (mismo Gmail)
- ACADEMY_EMAIL    (mismo Gmail u otro destino)
(opc.) WEBHOOK_URL
*/
const PORT       = process.env.PORT || 10000;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
const ADMIN_KEY  = process.env.ADMIN_KEY || 'cambia-esta-clave';
const ALLOWED    = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Mapeo de correos de profesores (por nombre)
const PROF_EMAILS = {
  'Lourdes':  'paupaulanguages2@gmail.com',
  'Santiago': 'paupaulanguages10@gmail.com',
  'Milena':   'paupaulanguages13@gmail.com',
  'Gissel':   'paauutooledo@gmail.com',
  'Heliana':  'paupaulanguages9@gmail.com'
};

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

// ===== Mailer (Nodemailer) =====
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
    secure: SMTP_PORT === 465, // SSL sólo si 465
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  transporter.verify()
    .then(() => console.log('[mail] Transporte SMTP listo ✅'))
    .catch(err => console.error('[mail] Error SMTP ❌', err?.message));
} else {
  console.warn('[mail] SMTP no configurado. Seteá SMTP_HOST/PORT/USER/PASS/FROM_EMAIL/ACADEMY_EMAIL.');
}

// ===== Health =====
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ============================================================
   Helpers SQL
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
        AND r.estado = 'bloqueado'
    ) THEN 'bloqueado'
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

const HAS_PAGADO = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado') AS has_pagado`;
const HAS_BLOQ   = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='bloqueado') AS has_bloqueado`;
const HAS_PEND   = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.reservado_hasta>now()) AS has_pendiente`;

const DAY_ORDER = `array_position(
  ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana
)`;

// ===== Helpers varios =====
function genGroupRef() {
  return 'grp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function safeStr(v, fallback = '') {
  return (v === undefined || v === null) ? fallback : String(v);
}
function renderFormDetails(form) {
  if (!form || typeof form !== 'object') return '<p>(Sin datos del formulario)</p>';
  const rows = Object.entries(form).map(([k, v]) => {
    const key = safeStr(k).replace(/_/g, ' ');
    const val = typeof v === 'object' ? JSON.stringify(v) : safeStr(v, '—');
    return `<tr><td style="padding:4px 8px;"><b>${key}</b></td><td style="padding:4px 8px;">${val}</td></tr>`;
  }).join('');
  return `<table border="0" cellpadding="0" cellspacing="0">${rows}</table>`;
}
function renderStudentEmail({ alumnoNombre, profesorNombre, horariosTexto, profesorEmail }) {
  const subject = `¡Bienvenido/a! ${alumnoNombre}`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif">
    <p>¡Hola ${alumnoNombre}!</p>
    <p>¡Qué alegría que seas parte de nuestra Escuela! Estoy feliz de recibirte y darte la bienvenida.</p>
    <p>En Paupau Languages conectamos personas con el mundo y a partir de hoy también serás parte a través del idioma.</p>
    <p><b>Tu docente:</b> ${profesorNombre}</p>
    <p><b>Tus clases:</b> ${horariosTexto} (hora Argentina). Es importante la puntualidad y usar cámara/micrófono para una mejor experiencia.</p>
    <p>Más cerca del inicio te enviaremos los links de acceso.</p>
    <p><b>Profesor/tutor:</b> ${profesorNombre} — <a href="mailto:${profesorEmail}">${profesorEmail || ''}</a></p>
    <p>Ante dudas o si no podés asistir, escribí a tu profesor para recibir el material y ponerte al día.</p>
    <p><b>Aranceles:</b> del 1 al 7 de cada mes por transferencia bancaria. Si no se abona en tiempo y forma, las clases se suspenden automáticamente.</p>
    <p>¡Que tengas una excelente experiencia!<br/>Ana Paula Toledo Del Grosso, Founder of PauPauLanguages.</p>
    <p>Instagram: <b>@paupaulanguages</b></p>
  </div>
  `;
  return { subject, html };
}
function renderBackofficeEmail({ alumnoNombre, alumnoEmail, profesorNombre, profesorEmail, horariosTexto, form }) {
  const subject = `Nueva inscripción confirmada: ${alumnoNombre} con ${profesorNombre}`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif">
    <h2>Nueva inscripción confirmada</h2>
    <p><b>Alumno:</b> ${alumnoNombre} (${alumnoEmail || '—'})</p>
    <p><b>Profesor:</b> ${profesorNombre} (${profesorEmail || '—'})</p>
    <p><b>Horarios:</b> ${horariosTexto}</p>
    <h3>Formulario</h3>
    ${renderFormDetails(form)}
  </div>
  `;
  return { subject, html };
}

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

// Hold por 10 minutos (desde el público)
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
              r.estado = 'pagado' OR
              r.estado = 'bloqueado' OR
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

// Crear preferencia (soporta 1 ó varios horarios)
app.post('/crear-preferencia', async (req, res) => {
  const {
    title, price, currency = 'ARS', back_urls = {}, metadata = {},
    horario_id, horarios_ids, alumno_nombre, alumno_email, form
  } = req.body || {};

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_request', message: 'title requerido' });
  if (typeof price !== 'number' || !(price > 0)) return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'bad_request', message: 'currency inválida' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });

  const name  = (alumno_nombre && String(alumno_nombre).trim()) || 'N/A';
  const email = (alumno_email  && String(alumno_email).trim())  || 'noemail@paupau.local';

  // Normalizar a array de horarios
  const ids = Array.isArray(horarios_ids) && horarios_ids.length
    ? horarios_ids.map(Number).filter(Boolean)
    : (horario_id ? [Number(horario_id)] : []);

  if (ids.length === 0) return res.status(400).json({ error: 'bad_request', message: 'horarios_ids/horario_id requerido' });

  // Generar un group_ref si hay más de un horario (o siempre, para unificar)
  const groupRef = genGroupRef();

  try {
    await pool.query('BEGIN');

    // Validar disponibilidad de TODOS los horarios
    const can = await pool.query(
      `
      SELECT h.id
      FROM horarios h
      WHERE h.id = ANY($1::int[])
        AND NOT EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.horario_id = h.id
            AND (
              r.estado = 'pagado' OR
              r.estado = 'bloqueado' OR
              (r.estado = 'pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta > now())
            )
        )`,
      [ids]
    );
    if (can.rowCount !== ids.length) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'not_available' });
    }

    // Insertar PENDIENTES para cada horario (10 min de hold)
    const reservasIds = [];
    for (const hId of ids) {
      const ins = await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta, group_ref, form_json)
         VALUES ($1,$2,$3,'pendiente', now() + interval '10 minutes', $4, $5)
         RETURNING id`,
        [hId, name, email, groupRef, form || {}]
      );
      reservasIds.push(ins.rows[0].id);
    }

    await pool.query('COMMIT');

    // Crear preferencia MP (guardamos group_ref en metadata)
    const pref = {
      items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      metadata: { ...metadata, group_ref: groupRef }
    };

    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      group_ref: groupRef,
      reservas_ids: reservasIds
    });
  } catch (e) {
    await pool.query('ROLLBACK').catch(()=>{});
    console.error('[crear-preferencia]', e?.message);
    return res.status(502).json({ error: 'mp_failed', message: e?.message || 'unknown' });
  }
});

// Webhook (marca pagado TODO el grupo y envía mails)
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  // ¿Es evento de pago?
  const isPayment = (evento?.type === 'payment') || (String(evento?.action || '').includes('payment'));
  if (!isPayment) return res.sendStatus(200);

  let paymentId = evento?.data?.id || null;
  let groupRef =
    evento?.data?.metadata?.group_ref ||
    evento?.data?.payment?.metadata?.group_ref ||
    null;

  // Intentar completar datos consultando el pago
  try {
    if (!paymentId || !groupRef) {
      if (evento?.data?.id) paymentId = evento.data.id;
      if (paymentId) {
        const pay = await mercadopago.payment.findById(paymentId).catch(() => null);
        const body = pay?.response || pay?.body || {};
        paymentId = paymentId || body?.id;
        groupRef  = groupRef || body?.metadata?.group_ref || null;

        const status = String(body?.status || '').toLowerCase();
        if (status && status !== 'approved') return res.sendStatus(200);
      }
    }
  } catch (e) {
    console.warn('[webhook] no se pudo consultar payment:', e?.message);
  }
  if (!groupRef) return res.sendStatus(200);

  try {
    // 1) Marcar como PAGADO todo el grupo
    await pool.query(
      `UPDATE reservas
         SET estado='pagado', reservado_hasta=NULL
       WHERE group_ref=$1 AND estado='pendiente'`,
      [groupRef]
    );

    // 2) Traer todas las reservas del grupo para armar emails
    const q = await pool.query(`
      SELECT
        r.id AS reserva_id, r.alumno_nombre, r.alumno_email, COALESCE(r.email_enviado,false) AS email_enviado,
        r.form_json,
        h.id AS horario_id, h.dia_semana, to_char(h.hora,'HH24:MI') AS hora_hhmm,
        p.nombre AS profesor_nombre
      FROM reservas r
      JOIN horarios h ON h.id = r.horario_id
      JOIN profesores p ON p.id = h.profesor_id
      WHERE r.group_ref = $1
      ORDER BY r.id ASC
    `, [groupRef]);

    if (q.rowCount === 0) return res.sendStatus(200);

    // Evitar reenvíos múltiples si ya se enviaron todos
    const yaEnviado = q.rows.every(r => r.email_enviado);
    if (yaEnviado) return res.sendStatus(200);

    // 3) Datos comunes
    const alumnoNombre   = q.rows[0].alumno_nombre || 'Alumno/a';
    const alumnoEmail    = q.rows[0].alumno_email;
    const profesorNombre = q.rows[0].profesor_nombre || 'Profesor/a';
    const profesorEmail  = PROF_EMAILS[profesorNombre] || null;

    // Todos los horarios del grupo en texto
    const horariosTexto = q.rows.map(r => `${r.dia_semana} ${r.hora_hhmm}`).join(' · ');

    // Tomar el primer form_json no vacío
    const form = (q.rows.find(r => r.form_json && Object.keys(r.form_json || {}).length)?.form_json) || {};

    // 4) Enviar correos
    if (transporter) {
      // Alumno
      if (alumnoEmail) {
        const m1 = renderStudentEmail({
          alumnoNombre,
          profesorNombre,
          horariosTexto,
          profesorEmail
        });
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: alumnoEmail,
          subject: m1.subject,
          html: m1.html
        });
      }

      // Academia (CC profesor) con formulario completo
      const m2 = renderBackofficeEmail({
        alumnoNombre,
        alumnoEmail,
        profesorNombre,
        profesorEmail,
        horariosTexto,
        form
      });
      await transporter.sendMail({
        from: FROM_EMAIL,
        to: ACADEMY_EMAIL,
        cc: profesorEmail || undefined,
        subject: m2.subject,
        html: m2.html,
        replyTo: alumnoEmail || undefined
      });

      // 5) Marcar todo el grupo como "email_enviado = true"
      await pool.query(`UPDATE reservas SET email_enviado = true WHERE group_ref = $1`, [groupRef]);
    } else {
      console.error('[webhook] transporter SMTP no configurado');
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook error]', e);
    return res.sendStatus(200);
  }
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

// PRUEBA de correo (debug)
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

    await pool.query(`DELETE FROM horarios WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /admin/horarios/:id]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Liberar cupo (admin): cancela todo y deja disponible
app.post('/admin/horarios/:id/liberar', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    await pool.query(
      `UPDATE reservas
         SET estado='cancelado'
       WHERE horario_id=$1
         AND estado IN ('pendiente','bloqueado','pagado')`,
      [id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /admin/horarios/:id/liberar]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Cambiar estado manual (usa fecha MUY futura para "bloqueado")
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
      return res
        .status(409)
        .json({ error: 'paid', message: 'Cupo pagado: primero usá "Liberar cupo".' });
    }

    if (estado === 'disponible') {
      await pool.query(
        `UPDATE reservas
           SET estado='cancelado'
         WHERE horario_id=$1
           AND estado IN ('pendiente','bloqueado','pagado')`,
        [id]
      );
      return res.json({ ok: true });
    }

    if (estado === 'pendiente') {
      await pool.query(
        `UPDATE reservas
           SET estado='cancelado'
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
        `UPDATE reservas
           SET estado='cancelado'
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

// ===== 404 =====
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
