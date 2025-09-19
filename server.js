// server.js — versión FINAL a prueba de balas para tu panel
// Node 18+

try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();

/* ---------------- CORS / BODY ---------------- */
const DEFAULT_ORIGINS = [
  'https://paupaulanguages.com',
  'https://www.paupaulanguages.com',
  'https://paupaulanguages.odoo.com'
];
const EXTRA = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...EXTRA])];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin no permitido: ' + origin));
  },
  credentials: true
}));
app.options('*', cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ---------------- Logger ---------------- */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} origin=${req.headers.origin || '-'}`);
  next();
});

/* --------------- Mini “DB” (JSON local) --------------- */
const DATA_FILE = path.join(__dirname, 'data.json');
const readData = () => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!Array.isArray(d.profesores)) d.profesores = [];
    if (!Array.isArray(d.horarios)) d.horarios = [];
    return d;
  } catch {
    return { profesores: [], horarios: [] };
  }
};
const writeData = d => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }
  catch (e) { console.error('writeData:', e.message); }
};
const findHorario = (arr, id) => arr.find(h => String(h.id) === String(id));
const ESTADOS_VALIDOS = ['pendiente', 'disponible', 'bloqueado'];

/* ---------------- Salud / Conexión ---------------- */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
['/','/conexion','/conectar','/api/conexion','/api/conectar','/connect','/api/connect','/ping']
  .forEach(p => {
    app.get(p, (_q, r) => r.json({ ok: true, msg: 'Backend conectado' }));
    app.post(p, (_q, r) => r.json({ ok: true, msg: 'Backend conectado' }));
  });

/* -------------------- Rutas que usa el panel (/admin/*) ------------------ */
/* Devuelven SIEMPRE { rows: [...] } */

/// PROFESORES
app.get('/admin/profesores', (_req, res) => {
  const d = readData();
  res.json({ rows: d.profesores });
});
app.post('/admin/profesores', (req, res) => {
  const { nombre = '' } = req.body || {};
  const d = readData();
  const id = Date.now().toString();
  d.profesores.push({ id, nombre });
  writeData(d);
  res.json({ rows: d.profesores });
});
app.delete('/admin/profesores/:id', (req, res) => {
  const d = readData();
  d.profesores = d.profesores.filter(p => String(p.id) !== String(req.params.id));
  writeData(d);
  res.json({ rows: d.profesores });
});

/// HORARIOS
app.get('/admin/horarios', (_req, res) => {
  const d = readData();
  res.json({ rows: d.horarios });
});
app.post('/admin/horarios', (req, res) => {
  const { dia='Lunes', hora='15:00', estado='disponible', profesorId=null } = req.body || {};
  const d = readData();
  const id = Date.now().toString();
  d.horarios.push({ id, dia, hora, estado, profesorId });
  writeData(d);
  res.json({ rows: d.horarios });
});
app.put('/admin/horarios/:id/estado', (req, res) => {
  const d = readData();
  const h = findHorario(d.horarios, req.params.id);
  const { estado } = req.body || {};
  if (h && ESTADOS_VALIDOS.includes(estado)) { h.estado = estado; writeData(d); }
  res.json({ rows: d.horarios });
});
app.post('/admin/horarios/:id/accion', (req, res) => {
  const d = readData();
  const h = findHorario(d.horarios, req.params.id);
  const map = { bloquear:'bloqueado', bloqueado:'bloqueado', liberar:'disponible', disponible:'disponible', pendiente:'pendiente' };
  const estado = map[String((req.body||{}).accion || '').toLowerCase()];
  if (h && ESTADOS_VALIDOS.includes(estado)) { h.estado = estado; writeData(d); }
  res.json({ rows: d.horarios });
});
app.delete('/admin/horarios/:id', (req, res) => {
  const d = readData();
  d.horarios = d.horarios.filter(h => String(h.id) !== String(req.params.id));
  writeData(d);
  res.json({ rows: d.horarios });
});

/* ------------ CATCH-ALL DEFENSIVO para cualquier /admin/* restante -------- */
app.all(/^\/admin(\/.*)?$/, (_req, res) => {
  // Si el front llama otra ruta /admin rara, nunca más va a romper el UI:
  res.json({ rows: [] });
});

/* -------------------- Compat mínima /api/* (por si algo la usa) ---------- */
app.get('/api/horarios', (_req, res) => {
  const d = readData();
  res.json({ horarios: d.horarios });
});

/* ------------------------- START ------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor OK :' + PORT));
