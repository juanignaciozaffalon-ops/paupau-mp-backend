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
- ALLOWED_ORIGIN
- DATABASE_URL
- ADMIN_KEY
- (opcional) WEBHOOK_URL

// 👇 PARA EMAIL
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASS
- FROM_EMAIL
- ACADEMY_EMAIL
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

// ===== MP SDK =====
try {
  mercadopago.configure({ access_token: MP_TOKEN });
  console.log('[boot] Mercado Pago SDK configurado ✅');
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
  console.warn('[mail] Variables SMTP incompletas.');
}

// ===== Plantillas de correo =====
function renderStudentEmail({ alumnoNombre, profesorNombre, horarioTexto, profesorEmail }) {
  const subject = `¡Bienvenido/a a PauPau Languages!`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
    <p>¡Hola ${alumnoNombre}!</p>
    <p><b>¡Qué alegría que seas parte de nuestra Escuela!</b> Estoy feliz de recibirte y darte la bienvenida.</p>
    <p>En <b>Paupau Languages</b>, conectamos personas con el mundo y a partir de hoy también serás parte de esas personas conectadas a través del idioma.</p>
    <p>Te recordamos que tu docente <b>${profesorNombre}</b> te espera en clases todos los <b>${horarioTexto}</b> (Hora argentina).</p>
    <p><b>P/D:</b> Si te gustan las redes sociales, podés seguirnos en Instagram como <b>@paupaulanguages</b>.</p>
    <p><b>Profesor / tutor:</b> ${profesorNombre}<br/>
    Mail directo: <b>${profesorEmail || '—'}</b></p>
    <p><b>Aranceles:</b> Se abonan del 1 al 7 de cada mes por transferencia bancaria.</p>
    <p>Esperamos desde PauPau Languages que tu experiencia sea la más grata posible.</p>
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
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id = h.id AND r.estado = 'pagado') THEN 'ocupado'
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id = h.id AND r.estado = 'bloqueado') THEN 'bloqueado'
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id = h.id AND r.estado = 'pendiente' AND r.reservado_hasta > now()) THEN 'pendiente'
    ELSE 'disponible'
  END
`;

/* ============================================================
   PÚBLICO
============================================================ */
// ... (tu código de horarios, hold, release, crear-preferencia se mantiene igual)

// Webhook (marca pagado y envía correos)
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  const isPayment = (evento?.type === 'payment') || (String(evento?.action || '').includes('payment'));
  if (!isPayment) return res.sendStatus(200);

  let paymentId = evento?.data?.id || null;
  let horarioIdFromMetadata = evento?.data?.metadata?.horario_id || null;

  try {
    if ((!horarioIdFromMetadata || !paymentId) && evento?.data?.id) {
      const pay = await mercadopago.payment.findById(evento.data.id).catch(() => null);
      const body = pay?.response || pay?.body || {};
      paymentId = paymentId || body?.id;
      horarioIdFromMetadata = horarioIdFromMetadata || body?.metadata?.horario_id || null;
      const status = String(body?.status || '').toLowerCase();
      if (status && status !== 'approved') return res.sendStatus(200);
    }
  } catch (e) {
    console.warn('[webhook] no se pudo consultar payment:', e?.message);
  }

  if (!horarioIdFromMetadata) return res.sendStatus(200);

  try {
    const upd = await pool.query(
      `UPDATE reservas
         SET estado='pagado', reservado_hasta=NULL
       WHERE horario_id=$1 AND estado='pendiente'
       RETURNING id`,
      [horarioIdFromMetadata]
    );

    if (upd.rowCount > 0) console.log(`[DB] Reserva confirmada ${horarioIdFromMetadata}`);

    const q = await pool.query(`
      SELECT
        r.id AS reserva_id, r.alumno_nombre, r.alumno_email, r.email_enviado,
        h.id AS horario_id, h.dia_semana, to_char(h.hora,'HH24:MI') AS hora_hhmm,
        p.nombre AS profesor_nombre, p.email AS profesor_email
      FROM reservas r
      JOIN horarios h ON h.id = r.horario_id
      JOIN profesores p ON p.id = h.profesor_id
      WHERE r.horario_id = $1
      ORDER BY r.id DESC
      LIMIT 1
    `, [horarioIdFromMetadata]);

    const row = q.rows[0];
    if (!row || row.email_enviado) return res.sendStatus(200);

    const alumnoNombre   = row.alumno_nombre || 'Alumno/a';
    const alumnoEmail    = row.alumno_email;
    const profesorNombre = row.profesor_nombre || 'Profesor/a';
    const profesorEmail  = row.profesor_email;
    const horarioTexto   = formatHorario(row.dia_semana, row.hora_hhmm);

    if (alumnoEmail) {
      const m1 = renderStudentEmail({ alumnoNombre, profesorNombre, horarioTexto, profesorEmail });
      await transporter.sendMail({ from: FROM_EMAIL, to: alumnoEmail, subject: m1.subject, html: m1.html });
    }

    const m2 = renderBackofficeEmail({
      alumnoNombre, alumnoEmail, profesorNombre, profesorEmail,
      horarioTexto, horarioId: row.horario_id, reservaId: row.reserva_id, pagoId: paymentId
    });
    await transporter.sendMail({
      from: FROM_EMAIL, to: ACADEMY_EMAIL, cc: profesorEmail || undefined,
      subject: m2.subject, html: m2.html, replyTo: alumnoEmail || undefined
    });

    await pool.query(`UPDATE reservas SET email_enviado=true WHERE id=$1`, [row.reserva_id]);
    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook error]', e);
    return res.sendStatus(200);
  }
});

/* ============================================================
   ADMIN
============================================================ */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// === Ruta de PRUEBA ===
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
    await transporter.sendMail({ from: FROM_EMAIL, to: alumnoEmail || ACADEMY_EMAIL, subject: m1.subject, html: m1.html });

    const m2 = renderBackofficeEmail({
      alumnoNombre: alumnoNombre || 'Alumno Demo',
      alumnoEmail: alumnoEmail || 'demo@alumno.com',
      profesorNombre: profesorNombre || 'Profesor Demo',
      profesorEmail: profesorEmail || 'profesor@demo.com',
      horarioTexto: horario || 'Lunes 18:00',
      horarioId: 999, reservaId: 123, pagoId: 'test123'
    });
    await transporter.sendMail({ from: FROM_EMAIL, to: ACADEMY_EMAIL, cc: profesorEmail, subject: m2.subject, html: m2.html });
    res.json({ ok: true, message: 'Correos enviados (test)' });
  } catch (e) {
    console.error('[debug/send-test-all]', e);
    res.status(500).json({ error: 'send_fail', message: e?.message });
  }
});

// ===== Start =====
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
