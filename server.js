// server.js
// Minimal, compatible con tu panel (devuelve { rows: [...] } en /admin/*)
// Node 18+

// dotenv opcional (no rompe si no está)
try { require('dotenv').config(); } catch (_) { console.log('dotenv no instalado'); }

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();

/* ----------------- CORS / BODY ----------------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_ORIGINS = [
  'https://paupaulanguages.com',
  'https://www.paupaulanguages.com',
  'https://paupaulanguages.odoo.com'
];

const ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ALLOWED_ORIGINS])];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow curl, server-side requests
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin no permitido: ' + origin));
  },
  credentials: true
}));
app.options('*', cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// simple logger (para ver qué pide el frontend)
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

/* ----------------- JSON "DB" ----------------- */
// data.json persistido en la app (en Render es efímero pero sirve)
const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.profesores)) parsed.profesores = [];
    if (!Array.isArray(parsed.horarios)) parsed.horarios = [];
    return parsed;
  } catch {
    // si no existe, devolvemos estructura vacía
    return { profesores: [], horarios: [] };
  }
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('writeData error:', e && e.message);
  }
}

function findHorario(horarios, id) {
  return horarios.find(h => String(h.id) === String(id));
}

const ESTADOS_VALIDOS = ['pendiente', 'disponible', 'bloqueado'];

/* ----------------- HEALTH / CONEXIÓN ----------------- */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
// Aceptamos varias rutas de "conexión" por si el front usa cualquier variante
['/', '/conexion', '/conectar', '/api/conexion', '/api/conectar', '/connect', '/api/connect', '/ping']
  .forEach(p => { app.get(p, (_req, res) => res.json({ ok: true, msg: 'Backend conectado' })); app.post(p, (_req, res) => res.json({ ok: true, msg: 'Backend conectado' })); });

/* ----------------- /admin (lo que usa el panel) ----------------- */
/* IMPORTANTE: el panel espera { rows: [...] } */

/// PROFESORES
app.get('/admin/profesores', (_req, res) => {
  const data = readData();
  return res.json({ rows: data.profesores });
});

app.post('/admin/profesores', (req, res) => {
  const { nombre = '' } = req.body || {};
  const data = readData();
  const id = Date.now().toString();
  const profesor = { id, nombre };
  data.profesores.push(profesor);
  writeData(data);
  return res.json({ rows: data.profesores });
});

app.delete('/admin/profesores/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();
  data.profesores = data.profesores.filter(p => String(p.id) !== String(id));
  writeData(data);
  return res.json({ rows: data.profesores });
});

/// HORARIOS
app.get('/admin/horarios', (_req, res) => {
  const data = readData();
  return res.json({ rows: data.horarios });
});

app.post('/admin/horarios', (req, res) => {
  const { dia = 'Lunes', hora = '15:00', estado = 'disponible', profesorId = null } = req.body || {};
  const data = readData();
  const id = Date.now().toString();
  const nuevo = { id, dia, hora, estado, profesorId };
  data.horarios.push(nuevo);
  writeData(data);
  return res.json({ rows: data.horarios });
});

app.put('/admin/horarios/:id/estado', (req, res) => {
  const { id } = req.params;
  const { estado } = req.body || {};
  const data = readData();
  const h = findHorario(data.horarios, id);
  if (h && ESTADOS_VALIDOS.includes(estado)) {
    h.estado = estado;
    writeData(data);
  }
  return res.json({ rows: data.horarios });
});

// acción (dropdown) — acepta 'liberar', 'bloquear', 'pendiente', etc.
app.post('/admin/horarios/:id/accion', (req, res) => {
  const { id } = req.params;
  const { accion } = req.body || {};
  const map = { bloquear: 'bloqueado', bloqueado: 'bloqueado', liberar: 'disponible', disponible: 'disponible', pendiente: 'pendiente' };
  const estado = map[String(accion || '').toLowerCase()];
  const data = readData();
  const h = findHorario(data.horarios, id);
  if (h && ESTADOS_VALIDOS.includes(estado)) {
    h.estado = estado;
    writeData(data);
  }
  return res.json({ rows: data.horarios });
});

app.delete('/admin/horarios/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();
  data.horarios = data.horarios.filter(h => String(h.id) !== String(id));
  writeData(data);
  return res.json({ rows: data.horarios });
});

/* ----------------- BACKWARD /api compat (opcional) ----------------- */
// Mantengo endpoints /api por compatibilidad si alguna parte del front los usa

app.get('/api/horarios', (_req, res) => {
  const data = readData();
  return res.json({ horarios: data.horarios });
});

app.put('/api/horarios/:id/estado', (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body || {};
    if (!ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const data = readData();
    const h = findHorario(data.horarios, id);
    if (!h) return res.status(404).json({ error: 'Horario no encontrado' });
    h.estado = estado;
    writeData(data);
    return res.json({ ok: true, id, estado: h.estado });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'error servidor' });
  }
});

/* ----------------- START ----------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor OK en :' + PORT);
});
