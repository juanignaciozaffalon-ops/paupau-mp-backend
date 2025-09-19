// server.js — Backend MP + Postgres + Admin Panel (profesores/horarios)
// SDK v1.x de Mercado Pago

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');

const app = express();

/* ===== ENV esperadas en Render =====
- MP_ACCESS_TOKEN
- DATABASE_URL
- ALLOWED_ORIGIN                 (coma-separado; ej: https://www.paupaulanguages.com,https://paupaulanguages.odoo.com)
- ADMIN_KEY
*/
const PORT      = process.env.PORT || 10000;
const MP_TOKEN  = process.env.MP_ACCESS_TOKEN || '';
const ALLOWED   = (process.env.ALLOWED_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || 'cambia-esta-clave';

// ===== CORS mínimo =====
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const ok = ALLOWED.includes(origin);
  if (ok) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,PUT,OPTIONS');
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
  .then(()=> console.log('[DB] Conectado a Postgres ✅'))
  .catch(e => console.error('[DB] Error conexión ❌', e));

// ===== MP SDK v1.x =====
try {
  mercadopago.configure({ access_token: MP_TOKEN });
  console.log('[boot] Mercado Pago SDK configurado (v1.x)');
} catch(e){ console.error('[boot] Error MP SDK:', e?.message); }

// ===== Health =====
app.get('/health', (_req,res)=> res.json({ ok:true }));

/* ============================================================
   Helpers de “estado” por horario
============================================================ */
const STATE_CASE = `
  CASE
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado') THEN 'pagado'
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='bloqueado') THEN 'bloqueado'
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now()) THEN 'pendiente'
    ELSE 'disponible'
  END
`;

const DAY_ORDER = `array_position(
  ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana
)`;

/* ============================================================
   PÚBLICO
============================================================ */

// Listar horarios con estado
app.get('/horarios', async (_req,res)=>{
  try{
    const q = `
      SELECT
        h.id AS horario_id,
        p.id AS profesor_id,
        p.nombre AS profesor,
        h.dia_semana,
        to_char(h.hora,'HH24:MI') AS hora,
        ${STATE_CASE} AS estado
      FROM horarios h
      JOIN profesores p ON p.id=h.profesor_id
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  }catch(e){
    console.error('[GET /horarios]', e);
    res.status(500).json({ error:'db_error' });
  }
});

// Hold local (10 min) – opcional para pruebas
app.post('/hold', async (req,res)=>{
  const { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if(!horario_id) return res.status(400).json({ error:'bad_request', message:'horario_id requerido' });
  const nom = (alumno_nombre && String(alumno_nombre).trim()) || 'Hold manual';
  const mail= (alumno_email && String(alumno_email).trim()) || 'hold@admin.local';

  const client = await pool.connect();
  try{
    await client.query('BEGIN');

    const ok = await client.query(
      `SELECT 1
       FROM horarios h
       WHERE h.id=$1
         AND NOT EXISTS (
           SELECT 1 FROM reservas r
            WHERE r.horario_id=h.id
              AND ( r.estado='pagado'
                 OR r.estado='bloqueado'
                 OR (r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now())
              )
         )`,
      [horario_id]
    );
    if(ok.rowCount===0){ await client.query('ROLLBACK'); return res.status(409).json({ error:'not_available' }); }

    const { rows } = await client.query(
      `INSERT INTO reservas (horario_id, estado, alumno_nombre, alumno_email, reservado_hasta, created_at, creado_por_admin)
       VALUES ($1,'pendiente',$2,$3, now()+interval '10 minutes', now(), true)
       RETURNING id, reservado_hasta`,
      [horario_id, nom, mail]
    );

    await client.query('COMMIT');
    res.json({ id: rows[0].id, reservado_hasta: rows[0].reservado_hasta });
  }catch(e){
    await client.query('ROLLBACK');
    console.error('[POST /hold]', e);
    res.status(500).json({ error:'db_error', message:e.message });
  }finally{ client.release(); }
});

// Release de hold (pendiente → cancelado)
app.post('/release', async (req,res)=>{
  const { reserva_id } = req.body || {};
  if(!reserva_id) return res.status(400).json({ error:'bad_request' });
  try{
    const r = await pool.query(
      `UPDATE reservas SET estado='cancelado' WHERE id=$1 AND estado='pendiente' RETURNING id`,
      [reserva_id]
    );
    if(!r.rowCount) return res.status(404).json({ error:'not_found_or_not_pending' });
    res.json({ ok:true });
  }catch(e){
    console.error('[POST /release]', e);
    res.status(500).json({ error:'db_error' });
  }
});

// Crear preferencia MP (y auto-hold si viene horario_id)
app.post('/crear-preferencia', async (req,res)=>{
  const { title, price, currency='ARS', back_urls={}, metadata={}, horario_id, alumno_nombre, alumno_email } = req.body || {};
  if(!title || typeof title!=='string') return res.status(400).json({ error:'bad_request', message:'title requerido' });
  if(!(typeof price==='number' && price>0)) return res.status(400).json({ error:'bad_request', message:'price debe ser número > 0' });
  if(!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error:'bad_request', message:'currency inválida' });
  if(!MP_TOKEN) return res.status(500).json({ error:'server_config', message:'MP_ACCESS_TOKEN faltante' });

  const nom = (alumno_nombre && String(alumno_nombre).trim()) || 'Alumno Web';
  const mail= (alumno_email && String(alumno_email).trim()) || 'alumno@web.local';

  // Si viene horario_id → creamos un "pendiente" por 24h para bloquear el cupo
  if(horario_id){
    const client = await pool.connect();
    try{
      await client.query('BEGIN');

      const ok = await client.query(
        `SELECT 1
         FROM horarios h
         WHERE h.id=$1
           AND NOT EXISTS (
             SELECT 1 FROM reservas r
              WHERE r.horario_id=h.id
                AND ( r.estado='pagado'
                   OR r.estado='bloqueado'
                   OR (r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now())
                )
           )`,
        [horario_id]
      );
      if(ok.rowCount===0){ await client.query('ROLLBACK'); return res.status(409).json({ error:'not_available' }); }

      await client.query(
        `INSERT INTO reservas (horario_id, estado, alumno_nombre, alumno_email, reservado_hasta, created_at)
         VALUES ($1,'pendiente',$2,$3, now()+interval '24 hours', now())`,
        [horario_id, nom, mail]
      );
      await client.query('COMMIT');
    }catch(e){
      await client.query('ROLLBACK');
      console.error('[crear-preferencia] hold previo', e);
      return res.status(500).json({ error:'db_error', message:e.message });
    }finally{ client.release(); }
  }

  try{
    const pref = {
      items: [{ title, quantity:1, unit_price:price, currency_id:currency }],
      back_urls,
      auto_return: 'approved',
      metadata: { ...metadata, horario_id: horario_id || null }
    };
    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;
    return res.json({ id:data.id, init_point:data.init_point, sandbox_init_point:data.sandbox_init_point });
  }catch(e){
    console.error('[MP error]', e?.message, '\n[MP data]', e?.response?.body);
    res.status(502).json({ error:'mp_failed', message:e?.message || 'unknown' });
  }
});

// Webhook MP (marca pagado)
app.post('/webhook', async (req,res)=>{
  const ev = req.body;
  try {
    const meta = ev?.data?.metadata || ev?.metadata || {};
    const horario_id = meta?.horario_id || null;
    if(horario_id){
      await pool.query(
        `UPDATE reservas
            SET estado='pagado', reservado_hasta=NULL
          WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`,
        [horario_id]
      );
      console.log('[webhook] marcado pagado horario', horario_id);
    } else {
      console.log('[webhook] sin horario_id en metadata');
    }
  } catch(e){
    console.error('[webhook error]', e);
  }
  res.sendStatus(200);
});

// Cron: liberar pendientes vencidos
setInterval(async ()=>{
  try{
    const r = await pool.query(
      `UPDATE reservas
          SET estado='cancelado'
        WHERE estado='pendiente'
          AND reservado_hasta IS NOT NULL
          AND reservado_hasta < now()`
    );
    if(r.rowCount) console.log('[cron] pendientes vencidos:', r.rowCount);
  }catch(e){ console.error('[cron]', e); }
}, 60*1000);

/* ============================================================
   ADMIN
============================================================ */
function authAdmin(req,res,next){
  const key = req.headers['x-admin-key'] || req.query.key;
  if(!key || key!==ADMIN_KEY) return res.status(401).json({ error:'unauthorized' });
  next();
}

// ---- Profesores ----
app.get('/admin/profesores', authAdmin, async (_req,res)=>{
  try{
    const { rows } = await pool.query(`SELECT id,nombre FROM profesores ORDER BY nombre`);
    res.json(rows);
  }catch(e){ console.error('[GET /admin/profesores]', e); res.status(500).json({ error:'db_error' }); }
});

app.post('/admin/profesores', authAdmin, async (req,res)=>{
  const { nombre } = req.body || {};
  if(!nombre || !String(nombre).trim()) return res.status(400).json({ message:'nombre requerido' });
  try{
    const { rows } = await pool.query(
      `INSERT INTO profesores (nombre) VALUES ($1) RETURNING id,nombre`,
      [ String(nombre).trim() ]
    );
    res.json(rows[0]);
  }catch(e){ console.error('[POST /admin/profesores]', e); res.status(500).json({ error:'db_error' }); }
});

app.delete('/admin/profesores/:id', authAdmin, async (req,res)=>{
  const id = Number(req.params.id);
  if(!id) return res.status(400).json({ error:'bad_request' });
  try{
    const used = await pool.query(`SELECT 1 FROM horarios WHERE profesor_id=$1 LIMIT 1`, [id]);
    if(used.rowCount) return res.status(409).json({ error:'in_use', message:'Tiene horarios' });
    await pool.query(`DELETE FROM profesores WHERE id=$1`, [id]);
    res.json({ ok:true });
  }catch(e){ console.error('[DELETE /admin/profesores/:id]', e); res.status(500).json({ error:'db_error' }); }
});

// ---- Horarios ----
app.get('/admin/horarios', authAdmin, async (req,res)=>{
  const profesor_id = Number(req.query.profesor_id) || null;
  try{
    const params=[]; let where='';
    if(profesor_id){ where='WHERE h.profesor_id=$1'; params.push(profesor_id); }

    const q = `
      SELECT
        h.id,
        h.profesor_id,
        p.nombre AS profesor,
        h.dia_semana,
        to_char(h.hora,'HH24:MI') AS hora,
        ${STATE_CASE} AS estado,
        -- flags para el panel
        EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado')     AS has_pagado,
        EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='bloqueado')  AS has_bloqueado,
        EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now()) AS has_pendiente
      FROM horarios h
      JOIN profesores p ON p.id=h.profesor_id
      ${where}
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  }catch(e){
    console.error('[GET /admin/horarios]', e);
    res.status(500).json({ error:'db_error' });
  }
});

app.post('/admin/horarios', authAdmin, async (req,res)=>{
  const { profesor_id, dia_semana, hora } = req.body || {};
  if(!profesor_id || !dia_semana || !hora) return res.status(400).json({ error:'bad_request' });
  try{
    const { rows } = await pool.query(
      `INSERT INTO horarios (profesor_id, dia_semana, hora)
       VALUES ($1,$2,$3::time) RETURNING id, profesor_id, dia_semana, to_char(hora,'HH24:MI') as hora`,
      [profesor_id, dia_semana, hora]
    );
    res.json(rows[0]);
  }catch(e){
    console.error('[POST /admin/horarios]', e);
    res.status(500).json({ error:'db_error' });
  }
});

app.delete('/admin/horarios/:id', authAdmin, async (req,res)=>{
  const id = Number(req.params.id);
  if(!id) return res.status(400).json({ error:'bad_request' });
  try{
    const used = await pool.query(
      `SELECT 1 FROM reservas WHERE horario_id=$1 AND estado IN ('pagado','bloqueado','pendiente') LIMIT 1`,
      [id]
    );
    if(used.rowCount) return res.status(409).json({ error:'in_use', message:'Tiene reservas activas' });
    await pool.query(`DELETE FROM horarios WHERE id=$1`, [id]);
    res.json({ ok:true });
  }catch(e){
    console.error('[DELETE /admin/horarios/:id]', e);
    res.status(500).json({ error:'db_error' });
  }
});

/**
 * Cambiar estado desde el panel:
 * - accion=bloquear  -> crea reserva bloqueada (dummy NOT NULL), cancela pendientes
 * - accion=liberar   -> cancela bloqueados y pendientes
 * - accion=pendiente -> crea pendiente 10min (dummy NOT NULL) si está disponible
 */
app.post('/admin/horarios/:id/accion', authAdmin, async (req,res)=>{
  const id = Number(req.params.id);
  const accion = String((req.body||{}).accion || '').toLowerCase();
  if(!id || !accion) return res.status(400).json({ error:'bad_request' });

  const client = await pool.connect();
  try{
    await client.query('BEGIN');

    if(accion === 'bloquear'){
      // si hay pagado -> no se puede
      const paid = await client.query(`SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`, [id]);
      if(paid.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error:'already_paid' }); }
      // cancelar pendientes
      await client.query(`UPDATE reservas SET estado='cancelado' WHERE horario_id=$1 AND estado='pendiente'`, [id]);
      // insertar bloqueado (dummy NOT NULL)
      await client.query(
        `INSERT INTO reservas (horario_id, estado, alumno_nombre, alumno_email, creado_por_admin, created_at)
         VALUES ($1,'bloqueado','Bloqueo manual','bloqueo@admin.local',true, now())`,
        [id]
      );
      await client.query('COMMIT');
      return res.json({ ok:true, estado:'bloqueado' });
    }

    if(accion === 'liberar'){
      await client.query(
        `UPDATE reservas
            SET estado='cancelado'
          WHERE horario_id=$1 AND estado IN ('bloqueado','pendiente')`,
        [id]
      );
      await client.query('COMMIT');
      return res.json({ ok:true, estado:'disponible' });
    }

    if(accion === 'pendiente'){
      // No si hay pagado/bloqueado/pending vigente
      const busy = await client.query(
        `SELECT 1 FROM reservas
          WHERE horario_id=$1
            AND ( estado='pagado'
               OR estado='bloqueado'
               OR (estado='pendiente' AND reservado_hasta IS NOT NULL AND reservado_hasta>now())
            ) LIMIT 1`,
        [id]
      );
      if(busy.rowCount){ await client.query('ROLLBACK'); return res.status(409).json({ error:'not_available' }); }
      await client.query(
        `INSERT INTO reservas (horario_id, estado, alumno_nombre, alumno_email, reservado_hasta, creado_por_admin, created_at)
         VALUES ($1,'pendiente','Pendiente manual','pendiente@admin.local', now()+interval '10 minutes', true, now())`,
        [id]
      );
      await client.query('COMMIT');
      return res.json({ ok:true, estado:'pendiente' });
    }

    await client.query('ROLLBACK');
    res.status(400).json({ error:'accion_invalida' });
  }catch(e){
    await client.query('ROLLBACK');
    console.error('[POST /admin/horarios/:id/accion]', e);
    res.status(500).json({ error:'db_error', message:e.message });
  }finally{
    client.release();
  }
});

/* ============================================================
   START
============================================================ */
app.listen(PORT, () => {
  console.log(`Servidor OK :${PORT}`);
});
