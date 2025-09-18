// server.js — Backend MP + Postgres (SDK v1.5.17 compatible con configure)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');

const app = express();

// ===== Env =====
// En Render: MP_ACCESS_TOKEN, ALLOWED_ORIGIN (coma-separadas), DATABASE_URL, WEBHOOK_URL (opcional)
const PORT     = process.env.PORT || 10000;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const ALLOWED  = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ===== Postgres =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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

// ===== Listar horarios disponibles =====
// Opcionales: ?idioma=Español|Portugués  &  ?profesor=Nombre
app.get('/horarios', async (req, res) => {
  const { idioma, profesor } = req.query;

  // Armamos filtros seguros
  const conds = [];
  const vals = [];
  if (idioma)  { vals.push(idioma);   conds.push(`p.idioma = $${vals.length}`); }
  if (profesor){ vals.push(profesor); conds.push(`p.nombre = $${vals.length}`); }

  // Un horario está disponible si NO tiene:
  //  - reserva estado = 'pagado', o
  //  - reserva estado = 'pendiente' con reservado_hasta > ahora (hold activo)
  const whereExtra = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const sql = `
    SELECT
      h.id            AS horario_id,
      p.nombre        AS profesor,
      p.idioma        AS idioma,
      h.dia_semana,
      to_char(h.hora, 'HH24:MI') AS hora
    FROM horarios h
    JOIN profesores p   ON p.id = h.profesor_id
    LEFT JOIN reservas r ON r.horario_id = h.id
      AND (r.estado = 'pagado' OR (r.estado = 'pendiente' AND r.reservado_hasta > now()))
    ${whereExtra}
      AND r.id IS NULL
    ORDER BY p.nombre,
             array_position(ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana),
             h.hora;
  `;

  try {
    const q = await pool.query(sql, vals);
    res.json(q.rows);
  } catch (e) {
    console.error('[DB /horarios]', e);
    res.status(500).json({ error: 'db_failed', message: e.message });
  }
});

// ===== Crear preferencia (y reserva pendiente) =====
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

  // 1) Intentar tomar el cupo (hold de 10 min)
  try {
    if (horario_id) {
      // Inserta o ignora si ya existe una reserva activa para ese horario (índice único)
      const ins = await pool.query(
        `INSERT INTO reservas (horario_id, estado, reservado_hasta)
         VALUES ($1, 'pendiente', now() + interval '10 minutes')
         ON CONFLICT (horario_id)
         DO UPDATE SET -- si había algo conflictivo, sólo deja vigente si no está activo
           estado = CASE
                      WHEN reservas.estado = 'pendiente' AND reservas.reservado_hasta > now() THEN reservas.estado
                      WHEN reservas.estado = 'pagado' THEN reservas.estado
                      ELSE 'pendiente'
                    END,
           reservado_hasta = CASE
                               WHEN reservas.estado = 'pendiente' AND reservas.reservado_hasta > now() THEN reservas.reservado_hasta
                               WHEN reservas.estado = 'pagado' THEN reservas.reservado_hasta
                               ELSE now() + interval '10 minutes'
                             END
         RETURNING estado, reservado_hasta;`
      , [horario_id]);

      const row = ins.rows[0];
      // Si quedó en 'pagado' o quedó 'pendiente' pero con reservado_hasta previo (hold ajeno), rechazamos
      if (row.estado === 'pagado' || (row.estado === 'pendiente' && row.reservado_hasta < (new Date(Date.now() + 9.5*60*1000)))) {
        // Nota: esta heurística evita que tomes un hold si otro ya lo tiene activo.
        return res.status(409).json({ error: 'slot_taken', message: 'El horario ya fue tomado' });
      }
    }
  } catch (e) {
    console.error('[DB hold]', e);
    return res.status(409).json({ error: 'slot_taken', message: 'El horario ya fue tomado' });
  }

  // 2) Crear preferencia MP
  try {
    const pref = {
      items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      metadata: { ...metadata, horario_id },
      notification_url: process.env.WEBHOOK_URL || undefined, // para que MP llame a /webhook
    };

    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp && mpResp.body ? mpResp.body : mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
    });
  } catch (e) {
    console.error('[MP error]', e?.message, '\n[MP error data]', e?.response?.body);
    return res.status(502).json({
      error: 'mp_failed',
      message: e?.message || 'unknown',
      details: e?.response?.body || null,
    });
  }
});

// ===== Webhook para confirmar pago =====
// Configurá WEBHOOK_URL en Render apuntando a https://<tu-servicio>.onrender.com/webhook
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('[Webhook recibido]', JSON.stringify(evento));

  // Según la integración, Mercado Pago puede enviar distinta forma.
  // Guardamos horario_id en metadata de la preferencia/pago y lo leemos acá:
  const horario_id =
    evento?.data?.metadata?.horario_id ||
    evento?.data?.id && req.query?.horario_id || // fallback por si lo mandás en query
    null;

  // Ajustá acá las condiciones de evento segun la cuenta (approved, payment.created, etc.)
  // Lo simple: si tenemos horario_id, marcamos pagado.
  if (horario_id) {
    try {
      await pool.query(
        `UPDATE reservas
           SET estado='pagado', reservado_hasta = NULL
         WHERE horario_id=$1`,
        [horario_id]
      );
      console.log(`[DB] Reserva confirmada y bloqueada (horario ${horario_id})`);
    } catch (e) {
      console.error('[DB error webhook]', e);
    }
  }

  res.sendStatus(200);
});

// ===== Liberar reservas expiradas cada minuto =====
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE reservas
          SET estado='cancelado', reservado_hasta = NULL
        WHERE estado='pendiente'
          AND reservado_hasta < now()`
    );
    if (result.rowCount > 0) {
      console.log(`[cron] Reservas liberadas: ${result.rowCount}`);
    }
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
