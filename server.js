// server.js — Backend MP + Postgres + Admin Panel (profesores/horarios/estados)
// SDK v1.x de Mercado Pago (compatible con configure)

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();

/* ===== Env =====
Variables en Render:
- MP_ACCESS_TOKEN
- ALLOWED_ORIGIN  (coma-separadas, ej: https://www.paupaulanguages.com,https://odoo.com)
- DATABASE_URL
- ADMIN_KEY
- (opcional) WEBHOOK_URL

// 👇 PARA EMAIL (agregar en Render → Settings → Environment)
- SMTP_HOST           (ej: smtp.gmail.com)
- SMTP_PORT           (ej: 465 ó 587)
- SMTP_USER           (ej: paupaulanguagesadmi@gmail.com)
- SMTP_PASS           (App Password de Gmail, 16 caracteres sin espacios)
- FROM_EMAIL          (ej: el mismo Gmail)
- ACADEMY_EMAIL       (ej: el mismo Gmail)
*/
const PORT       = process.env.PORT || 10000;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
const ADMIN_KEY  = process.env.ADMIN_KEY || 'cambia-esta-clave';
const ALLOWED    = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

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
thePort = Number(process.env.SMTP_PORT || 587);
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
    secure: SMTP_PORT === 465, // true si 465 (SSL); con 587 hace STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  transporter.verify()
    .then(() => console.log('[mail] Transporte SMTP listo ✅'))
    .catch(err => console.error('[mail] Error SMTP ❌', err?.message));
} else {
  console.warn('[mail] Variables SMTP incompletas. Configurá SMTP_HOST/PORT/USER/PASS/FROM_EMAIL/ACADEMY_EMAIL en Render.');
}

// ===== Plantillas de correo =====
function renderStudentEmail({ alumnoNombre, profesorNombre, horarioTexto, profesorEmail }) {
  const subject = `¡Bienvenido/a a PauPau Languages!`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
    <p>¡Hola ${alumnoNombre}!</p>
    <p><b>¡Qué alegría que seas parte de nuestra Escuela!</b> Estoy feliz de recibirte y darte la bienvenida.</p>
    <p>En <b>Paupau Languages</b>, conectamos personas con el mundo y a partir de hoy también serás parte de esas personas conectadas a través del idioma.</p>
    <p>Te recordamos que tu docente <b>${profesorNombre}</b> te espera en clases todos los <b>${horarioTexto}</b> (Hora argentina). Es muy valiosa la puntualidad y el encendido de cámara y micrófono para la experiencia de aprendizaje. Más próxima a la fecha de inicio, tu docente te enviará los links de acceso correspondientes.</p>
    <p><b>P/D:</b> Si te gustan las redes sociales, podés seguirnos en Instagram como <b>@paupaulanguages</b>.</p>
    <p><b>Profesor / tutor:</b> ${profesorNombre}<br/>
    Mail directo: <b>${profesorEmail || '—'}</b></p>
    <p><b>Aranceles:</b> Se abonan del 1 al 7 de cada mes por transferencia bancaria. En caso de no abonar en tiempo y forma, automáticamente las clases se suspenderán.</p>
    <p>Esperamos desde PauPau Languages que tu experiencia sea la más grata posible. Recordá que estás en un sistema donde aprendés como nunca antes; que surjan dudas es normal. No dudes en contactarnos a nosotros o a tu profesor para aclararlas.</p>
    <p>¡Que tengas una excelente experiencia!</p>
    <p><b>Ana Paula Toledo Del Grosso</b><br/>Founder of PauPauLanguages</p>
  </div>
  `;
  return { subject, html };
}

function renderBackofficeEmail({ alumnoNombre, alumnoEmail, profesorNombre, profesorEmail, horarioTexto, horarioId, reservaId, pagoId }) {
  const subject = `Nueva inscripción confirmada: ${alumnoNombre} con ${profesorNombre}`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif">
    <h2>Nueva inscripción confirmada</h2>
    <ul>
      <li><b>Alumno:</b> ${alumnoNombre} (${alumnoEmail || '—'})</li>
      <li><b>Profesor:</b> ${profesorNombre} (${profesorEmail || '—'})</li>
      <li><b>Horario:</b> ${horarioTexto}</li>
      <li><b>Horario ID:</b> ${horarioId}</li>
      <li><b>Reserva ID:</b> ${reservaId}</li>
      <li><b>MP Payment ID:</b> ${pagoId || '—'}</li>
    </ul>
  </div>
  `;
  return { subject, html };
}

function formatHorario(dia, horaHHMM) {
  return `${dia} ${horaHHMM}`;
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

// Release explícito (desde público si hiciera falta)
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

// Crear preferencia (y auto-hold si viene horario_id)
app.post('/crear-preferencia', async (req, res) => {
  const { title, price, currency = 'ARS', back_urls = {}, metadata = {}, horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_request', message: 'title requerido' });
  if (typeof price !== 'number' || !(price > 0)) return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'bad_request', message: 'currency inválida' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });

  const name  = (alumno_nombre && String(alumno_nombre).trim()) || 'N/A';
  const email = (alumno_email  && String(alumno_email).trim())  || 'noemail@paupau.local';

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
                  r.estado = 'bloqueado' OR
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
          [horario_id, name, email]
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
      metadata: { ...metadata, horario_id }
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

// Webhook (marca pagado y ENVÍA CORREOS)
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  // Detectar pago
  const isPayment = (evento?.type === 'payment') || (String(evento?.action || '').includes('payment'));
  if (!isPayment) return res.sendStatus(200);

  // Obtener payment y metadata.horario_id
  let paymentId = evento?.data?.id || null;
  let horarioIdFromMetadata =
    evento?.data?.metadata?.horario_id ||
    evento?.data?.payment?.metadata?.horario_id ||
    null;

  try {
    if ((!horarioIdFromMetadata || !paymentId) && evento?.data?.id) {
      const pay = await mercadopago.payment.findById(evento.data.id).catch(() => null);
      const body = pay?.response || pay?.body || {};
      paymentId = paymentId || body?.id;
      horarioIdFromMetadata = horarioIdFromMetadata || body?.metadata?.horario_id || body?.additional_info?.items?.[0]?.id || null;

      const status = String(body?.status || '').toLowerCase();
      if (status && status !== 'approved') return res.sendStatus(200);
    }
  } catch (e) {
    console.warn('[webhook] no se pudo consultar payment:', e?.message);
  }

  if (!horarioIdFromMetadata) return res.sendStatus(200);

  try {
    // 1) marcar pagado si estaba pendiente
    await pool.query(
      `UPDATE reservas
         SET estado='pagado', reservado_hasta=NULL
       WHERE horario_id=$1 AND estado='pendiente'`,
      [horarioIdFromMetadata]
    );

    // 2) datos para mail (profesor + alumno + horario)
    const q = await pool.query(`
      SELECT
        r.id                 AS reserva_id,
        r.alumno_nombre,
        r.alumno_email,
        COALESCE(r.email_enviado,false) AS email_enviado,
        h.id                 AS horario_id,
        h.dia_semana,
        to_char(h.hora,'HH24:MI') AS hora_hhmm,
        p.nombre             AS profesor_nombre,
        p.email              AS profesor_email
      FROM reservas r
      JOIN horarios h ON h.id = r.horario_id
      JOIN profesores p ON p.id = h.profesor_id
      WHERE r.horario_id = $1
      ORDER BY r.id DESC
      LIMIT 1
    `, [horarioIdFromMetadata]);

    const row = q.rows[0];
    if (!row) return res.sendStatus(200);
    if (row.email_enviado) return res.sendStatus(200);

    const alumnoNombre   = row.alumno_nombre || 'Alumno/a';
    const alumnoEmail    = row.alumno_email;
    const profesorNombre = row.profesor_nombre || 'Profesor/a';
    const profesorEmail  = row.profesor_email || null;
    const horarioTexto   = formatHorario(row.dia_semana, row.hora_hhmm);

    if (transporter) {
      // Mail al alumno
      if (alumnoEmail) {
        const m1 = renderStudentEmail({ alumnoNombre, profesorNombre, horarioTexto, profesorEmail });
        await transporter.sendMail({ from: FROM_EMAIL, to: alumnoEmail, subject: m1.subject, html: m1.html });
      }
      // Mail a academia + CC profe
      const m2 = renderBackofficeEmail({
        alumnoNombre, alumnoEmail, profesorNombre, profesorEmail,
        horarioTexto, horarioId: row.horario_id, reservaId: row.reserva_id, pagoId: paymentId
      });
      await transporter.sendMail({
        from: FROM_EMAIL,
        to: ACADEMY_EMAIL,
        cc: profesorEmail || undefined,
        subject: m2.subject,
        html: m2.html,
        replyTo: alumnoEmail || undefined
      });

      // marcar como enviado (idempotencia)
      await pool.query(`UPDATE reservas SET email_enviado = true WHERE id = $1`, [row.reserva_id]);
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

// === Ruta de PRUEBA de correo (simple) ===
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

// === Ruta de PRUEBA que envía alumno + academia + CC profe ===
app.post('/debug/send-test-all', requireAdmin, async (req, res) => {
  try {
    const { alumnoNombre, alumnoEmail, profesorNombre, profesorEmail, horario } = req.body || {};
    if (!transporter) return res.status(500).json({ error: 'smtp_not_configured' });

    const m1 = renderStudentEmail({
      alumnoNombre: alumnoNombre || 'Alumno Demo',
      profesorNombre: profesorNombre || 'Profesor Demo',
      horarioTexto: horario || 'Lunes 18:00',
      profesorEmail: profesorEmail || 'profesor@demo.com'
    });
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: alumnoEmail || ACADEMY_EMAIL,
      subject: m1.subject,
      html: m1.html
    });

    const m2 = renderBackofficeEmail({
      alumnoNombre: alumnoNombre || 'Alumno Demo',
      alumnoEmail: alumnoEmail || 'demo@alumno.com',
      profesorNombre: profesorNombre || 'Profesor Demo',
      profesorEmail: profesorEmail || 'profesor@demo.com',
      horarioTexto: horario || 'Lunes 18:00',
      horarioId: 999,
      reservaId: 123,
      pagoId: 'test123'
    });
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: ACADEMY_EMAIL,
      cc: profesorEmail || undefined,
      subject: m2.subject,
      html: m2.html,
      replyTo: alumnoEmail || undefined
    });

    res.json({ ok: true, message: 'Correos enviados (test)' });
  } catch (e) {
    console.error('[debug/send-test-all]', e);
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
