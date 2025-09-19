// server.js — Backend MP + Postgres + Admin Panel
// Mercado Pago SDK v1.x

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');

const app = express();

/* ===== Env =====
- MP_ACCESS_TOKEN
- ALLOWED_ORIGIN   (coma-separadas)
- DATABASE_URL
- ADMIN_KEY
*/
const PORT      = process.env.PORT || 10000;
const MP_TOKEN  = process.env.MP_ACCESS_TOKEN;
const ALLOWED   = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || 'cambia-esta-clave';

// ===== CORS =====
app.use((req, res, next) => {
  const ok = ALLOWED.includes(req.headers.origin || '');
  if (ok) {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(ok ? 200 : 403);
  next();
});

app.use(bodyParser.json());

// ===== Postgres =====
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false }});
pool.connect().then(()=>console.log('[DB] Conectado ✅')).catch(e=>console.error('[DB] Error ❌',e.message));

// ===== MP SDK =====
try { mercadopago.configure({ access_token: MP_TOKEN }); console.log('[boot] MP SDK listo'); }
catch(e){ console.error('[boot] MP SDK error', e.message); }

// ===== Health =====
app.get('/health', (_req,res)=>res.json({ok:true}));

/* ============================================================
   Helpers (estado lógico)
   - “bloqueado” = reserva pendiente ADMIN con reservado_hasta > ahora + 30 días
============================================================ */
const ADMIN_NAME  = 'ADMIN';
const ADMIN_EMAIL = 'admin@paupaulanguages.com';
const BLOQ_HORIZON_SQL = "now() + interval '30 days'";
const BLOQ_INSERT_SQL  = "now() + interval '10 years'";

const STATE_CASE = `
  CASE
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado')
      THEN 'pagado'
    WHEN EXISTS (
      SELECT 1 FROM reservas r
       WHERE r.horario_id=h.id
         AND r.estado='pendiente'
         AND r.alumno_email='${ADMIN_EMAIL}'
         AND r.reservado_hasta > ${BLOQ_HORIZON_SQL}
    ) THEN 'bloqueado'
    WHEN EXISTS (
      SELECT 1 FROM reservas r
       WHERE r.horario_id=h.id
         AND r.estado='pendiente'
         AND r.reservado_hasta IS NOT NULL
         AND r.reservado_hasta > now()
    ) THEN 'pendiente'
    ELSE 'disponible'
  END
`;

const DAY_ORDER = `array_position(ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana)`;

/* ============================================================
   Público
============================================================ */

// Horarios para el formulario
app.get('/horarios', async (_req,res)=>{
  try{
    const q = `
      SELECT h.id AS horario_id, p.id AS profesor_id, p.nombre AS profesor,
             h.dia_semana, to_char(h.hora,'HH24:MI') AS hora, ${STATE_CASE} AS estado
      FROM horarios h JOIN profesores p ON p.id=h.profesor_id
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora`;
    const { rows } = await pool.query(q);
    res.json(rows);
  }catch(e){ console.error('[GET /horarios]',e); res.status(500).json({error:'db_error'}); }
});

// Hold 10 minutos (evita tomar pagados/bloqueados/pendientes vigentes)
app.post('/hold', async (req,res)=>{
  const { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if(!horario_id) return res.status(400).json({error:'bad_request'});
  try{
    await pool.query('BEGIN');
    const can = await pool.query(`
      SELECT 1 FROM horarios h
       WHERE h.id=$1 AND NOT EXISTS (
         SELECT 1 FROM reservas r
          WHERE r.horario_id=h.id AND (
            r.estado='pagado' OR
            (r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now())
          )
       )`, [horario_id]);
    if(!can.rowCount){ await pool.query('ROLLBACK'); return res.status(409).json({error:'not_available'}); }

    const ins = await pool.query(`
      INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
      VALUES ($1,$2,$3,'pendiente', now() + interval '10 minutes')
      RETURNING id, reservado_hasta`,
      [horario_id, alumno_nombre||'anon', alumno_email||'anon@example.com']);
    await pool.query('COMMIT');
    res.json({ id:ins.rows[0].id, reservado_hasta:ins.rows[0].reservado_hasta });
  }catch(e){ await pool.query('ROLLBACK'); console.error('[POST /hold]',e); res.status(500).json({error:'db_error'}); }
});

// Release público
app.post('/release', async (req,res)=>{
  const { reserva_id } = req.body || {};
  if(!reserva_id) return res.status(400).json({error:'bad_request'});
  try{
    const r = await pool.query(
      `UPDATE reservas SET estado='cancelado'
        WHERE id=$1 AND estado='pendiente' RETURNING id`, [reserva_id]);
    if(!r.rowCount) return res.status(404).json({error:'not_found_or_not_pending'});
    res.json({ok:true});
  }catch(e){ console.error('[POST /release]',e); res.status(500).json({error:'db_error'}); }
});

// Crear preferencia (y auto-hold si vino horario_id)
app.post('/crear-preferencia', async (req,res)=>{
  const { title, price, currency='ARS', back_urls={}, metadata={}, horario_id, alumno_nombre, alumno_email } = req.body || {};
  if(!title || typeof price!=='number' || price<=0) return res.status(400).json({error:'bad_request'});
  if(!MP_TOKEN) return res.status(500).json({error:'server_config'});

  try{
    if(horario_id){
      await pool.query('BEGIN');
      const can = await pool.query(`
        SELECT 1 FROM horarios h
         WHERE h.id=$1 AND NOT EXISTS(
           SELECT 1 FROM reservas r
            WHERE r.horario_id=h.id AND (
              r.estado='pagado' OR
              (r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now())
            )
         )`, [horario_id]);
      if(!can.rowCount){ await pool.query('ROLLBACK'); return res.status(409).json({error:'not_available'}); }

      await pool.query(`
        INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
        VALUES ($1,$2,$3,'pendiente', now() + interval '10 minutes')`,
        [horario_id, alumno_nombre||'anon', alumno_email||'anon@example.com']);
      await pool.query('COMMIT');
    }

    const pref = {
      items: [{ title, quantity:1, unit_price:price, currency_id:currency }],
      back_urls,
      auto_return: 'approved',
      external_reference: horario_id ? String(horario_id) : null, // 👈 clave para el webhook
      metadata: { ...metadata, horario_id: horario_id || null }
    };

    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;
    res.json({ id:data.id, init_point:data.init_point, sandbox_init_point:data.sandbox_init_point });
  }catch(e){
    console.error('[MP error]',e?.message, e?.response?.body);
    res.status(502).json({error:'mp_failed', message:e?.message||'unknown'});
  }
});

/* ========= Webhook =========
   MP envía { action:'payment.created', data:{ id: <paymentId> } }
   Buscamos el pago y leemos status + external_reference (=> horario_id)
*/
app.post('/webhook', async (req,res)=>{
  try{
    const paymentId = req.body?.data?.id || req.query?.id;
    if(!paymentId){ res.sendStatus(200); return; }

    const resp = await mercadopago.payment.findById(paymentId);
    const p    = resp?.body || resp?.response || {};
    const status = p.status; // 'approved' | 'pending' | ...
    const extRef = p.external_reference || p.metadata?.horario_id || null;
    const horarioId = extRef ? Number(String(extRef).replace(/[^\d]/g,'')) : null;

    if(status === 'approved' && horarioId){
      await pool.query(
        `UPDATE reservas
           SET estado='pagado', reservado_hasta=NULL
         WHERE horario_id=$1 AND estado='pendiente'`,
        [horarioId]
      );
      console.log(`[Webhook] horario ${horarioId} => pagado`);
    }
  }catch(e){
    console.error('[webhook error]', e?.message);
  }
  res.sendStatus(200);
});

// Cron: liberar holds vencidos
setInterval(async ()=>{
  try{
    const r = await pool.query(`
      UPDATE reservas
         SET estado='cancelado'
       WHERE estado='pendiente'
         AND reservado_hasta IS NOT NULL
         AND reservado_hasta < now()`);
    if(r.rowCount) console.log(`[cron] liberadas: ${r.rowCount}`);
  }catch(e){ console.error('[cron]',e.message); }
}, 60*1000);

/* ============================================================
   ADMIN (X-Admin-Key)
============================================================ */
function requireAdmin(req,res,next){
  const key = req.headers['x-admin-key'] || req.query.key;
  if(!key || key!==ADMIN_KEY) return res.status(401).json({error:'unauthorized'});
  next();
}

// Profes
app.get('/admin/profesores', requireAdmin, async (_req,res)=>{
  try{
    const { rows } = await pool.query(`SELECT id,nombre FROM profesores ORDER BY nombre`);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});
app.post('/admin/profesores', requireAdmin, async (req,res)=>{
  const { nombre } = req.body||{};
  if(!nombre) return res.status(400).json({error:'bad_request'});
  try{
    const { rows } = await pool.query(
      `INSERT INTO profesores (nombre) VALUES ($1) RETURNING id,nombre`, [String(nombre).trim()]);
    res.json(rows[0]);
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});
app.delete('/admin/profesores/:id', requireAdmin, async (req,res)=>{
  const id = Number(req.params.id)||0;
  if(!id) return res.status(400).json({error:'bad_request'});
  try{
    const used = await pool.query(`SELECT 1 FROM horarios WHERE profesor_id=$1 LIMIT 1`,[id]);
    if(used.rowCount) return res.status(409).json({error:'in_use'});
    await pool.query(`DELETE FROM profesores WHERE id=$1`,[id]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});

// Horarios
app.get('/admin/horarios', requireAdmin, async (req,res)=>{
  const profesor_id = Number(req.query.profesor_id)||null;
  try{
    const params=[]; let where='';
    if(profesor_id){ where='WHERE h.profesor_id=$1'; params.push(profesor_id); }
    const q = `
      SELECT h.id, h.profesor_id, p.nombre AS profesor,
             h.dia_semana, to_char(h.hora,'HH24:MI') AS hora,
             ${STATE_CASE} AS estado,
             EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado') AS has_pagado,
             EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.alumno_email='${ADMIN_EMAIL}' AND r.reservado_hasta>${BLOQ_HORIZON_SQL}) AS has_bloqueado,
             EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.reservado_hasta>now() AND NOT (r.alumno_email='${ADMIN_EMAIL}' AND r.reservado_hasta>${BLOQ_HORIZON_SQL})) AS has_pendiente
      FROM horarios h JOIN profesores p ON p.id=h.profesor_id
      ${where}
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});
app.post('/admin/horarios', requireAdmin, async (req,res)=>{
  const { profesor_id, dia_semana, hora } = req.body||{};
  if(!profesor_id||!dia_semana||!hora) return res.status(400).json({error:'bad_request'});
  try{
    const { rows } = await pool.query(
      `INSERT INTO horarios (profesor_id,dia_semana,hora)
       VALUES ($1,$2,$3::time) RETURNING id,profesor_id,dia_semana,to_char(hora,'HH24:MI') AS hora`,
       [profesor_id, dia_semana, hora]);
    res.json(rows[0]);
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});
app.delete('/admin/horarios/:id', requireAdmin, async (req,res)=>{
  const id = Number(req.params.id)||0;
  if(!id) return res.status(400).json({error:'bad_request'});
  try{
    const paid = await pool.query(`SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`,[id]);
    if(paid.rowCount) return res.status(409).json({error:'paid'});
    await pool.query(`DELETE FROM horarios WHERE id=$1`,[id]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});

/* === Cambiar estado manual: disponible | pendiente | bloqueado === */
app.post('/admin/horarios/:id/estado', requireAdmin, async (req,res)=>{
  const id = Number(req.params.id)||0;
  const { estado } = req.body||{};
  if(!id || !estado) return res.status(400).json({error:'bad_request'});

  try{
    await pool.query('BEGIN');

    if(estado==='disponible'){
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
          WHERE horario_id=$1
            AND (estado='pendiente')`, [id]);
      await pool.query('COMMIT');
      return res.json({ok:true});
    }

    // si hay pagado, no se puede forzar otro estado
    const paid = await pool.query(`SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`,[id]);
    if(paid.rowCount){ await pool.query('ROLLBACK'); return res.status(409).json({error:'paid_exists'}); }

    // limpiar anteriores admin/pending
    await pool.query(
      `UPDATE reservas SET estado='cancelado'
        WHERE horario_id=$1 AND estado='pendiente'`, [id]);

    if(estado==='pendiente'){
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,$2,$3,'pendiente', now() + interval '24 hours')`,
        [id, ADMIN_NAME, ADMIN_EMAIL]);
    }else if(estado==='bloqueado'){
      // “Bloqueado” = pendiente admin a largo plazo
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,$2,$3,'pendiente', ${BLOQ_INSERT_SQL})`,
        [id, ADMIN_NAME, ADMIN_EMAIL]);
    }else{
      await pool.query('ROLLBACK'); return res.status(400).json({error:'bad_request'});
    }

    await pool.query('COMMIT');
    res.json({ok:true});
  }catch(e){
    await pool.query('ROLLBACK');
    console.error('[admin estado] ', e.message);
    res.status(500).json({error:'db_error'});
  }
});

/* === Liberar cupo (admin) === */
app.post('/admin/horarios/:id/liberar', requireAdmin, async (req,res)=>{
  const id = Number(req.params.id)||0;
  if(!id) return res.status(400).json({error:'bad_request'});
  try{
    const r = await pool.query(
      `UPDATE reservas SET estado='cancelado'
        WHERE horario_id=$1 AND estado='pendiente'`, [id]);
    res.json({ok:true, released:r.rowCount});
  }catch(e){ console.error(e); res.status(500).json({error:'db_error'}); }
});

// ===== 404 =====
app.use((_req,res)=>res.status(404).json({error:'not_found'}));

app.listen(PORT, ()=>console.log(`🚀 http://localhost:${PORT}`));
