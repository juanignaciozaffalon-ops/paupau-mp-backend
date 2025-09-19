// server.js
// Node 18+ – MP SDK v1.5.17

// dotenv opcional
try { require('dotenv').config(); } catch (_) {
  console.log('dotenv no instalado; se usan variables de entorno del sistema.');
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');

const app = express();

/* ----------------------------- CORS / BODY ------------------------------ */
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
    if (!origin) return cb(null, true);            // curl/health/SSR
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin no permitido: ' + origin));
  },
  credentials: true
}));
app.options('*', cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ----------------------------- REQUEST LOGGER --------------------------- */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* -------------------------------- HEALTH -------------------------------- */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ------------------------- RUTAS DE CONEXIÓN GENÉRICAS ------------------ */
const conexionOK = (_req, res) =>
  res.json({ ok: true, msg: 'Backend conectado', version: '1.0.0' });

['/', '/conexion', '/conectar', '/api/conexion', '/api/conectar', '/connect', '/api/connect', '/ping']
  .forEach(p => { app.get(p, conexionOK); app.post(p, conexionOK); });

/* ---------------------------- ALMACÉN (JSON) ---------------------------- */
const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.horarios)) parsed.horarios = [];
    if (!Array.isArray(parsed.profesores)) parsed.profesores = [];
    return parsed;
  } catch {
    return { profesores: [], horarios: [] };
  }
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('No se pudo escribir data.json (FS efímero en Render):', e.message);
  }
}

function findHorario(horarios, id) {
  return horarios.find(h => String(h.id) === String(id));
}

const ESTADOS_VALIDOS = ['pendiente', 'disponible', 'bloqueado'];

/* -------------------------- ENDPOINTS DE PROFESORES --------------------- */
// (Tu UI los pide como /admin/profesores – devolvemos estructura simple)

app.get('/admin/profesores', (_req, res) => {
  const data = readData();
  res.json({ ok: true, profesores: data.profesores });
});

app.post('/admin/profesores', (req, res) => {
  const { nombre = '' } = req.body || {};
  const data = readData();
  const id = Date.now().toString();
  const profe = { id, nombre };
  data.profesores.push(profe);
  writeData(data);
  res.json({ ok: true, profesor: profe });
});

app.delete('/admin/profesores/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();
  const before = data.profesores.length;
  data.profesores = data.profesores.filter(p => String(p.id) !== String(id));
  writeData(data);
  res.json({ ok: true, deleted: before - data.profesores.length });
});

/* -------------------------- ENDPOINTS DE HORARIOS ------------------------ */
// API “oficial”
app.get('/api/horarios', (_req, res) => {
  const data = readData();
  res.json({ horarios: data.horarios });
});

app.post('/api/horarios', (req, res) => {
  const { dia = 'Lunes', hora = '15:00', estado = 'disponible', profesorId = null } = req.body || {};
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const data = readData();
  const id = Date.now().toString();
  const nuevo = { id, dia, hora, estado, profesorId };
  data.horarios.push(nuevo);
  writeData(data);
  res.json({ ok: true, horario: nuevo });
});

app.put('/api/horarios/:id/estado', (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body || {};
    if (!ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const data = readData();
    const h = findHorario(data.horarios, id);
    if (!h) return res.status(404).json({ error: 'Horario no encontrado' });
    h.estado = estado;
    writeData(data);
    res.json({ ok: true, id, estado: h.estado });
  } catch (err) {
    console.error('Error al actualizar estado:', err);
    res.status(500).json({ error: 'No se pudo actualizar el estado' });
  }
});

app.post('/api/horarios/:id/accion', (req, res) => {
  try {
    const { id } = req.params;
    const { accion } = req.body || {};
    if (!accion) return res.status(400).json({ error: 'Falta accion' });

    const map = {
      bloquear: 'bloqueado',
      bloqueado: 'bloqueado',
      liberar: 'disponible',
      disponible: 'disponible',
      pendiente: 'pendiente'
    };
    const estado = map[String(accion).toLowerCase()];
    if (!ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: 'Acción/estado inválido' });
    }

    const data = readData();
    const h = findHorario(data.horarios, id);
    if (!h) return res.status(404).json({ error: 'Horario no encontrado' });

    h.estado = estado;
    writeData(data);
    res.json({ ok: true, id, estado: h.estado });
  } catch (err) {
    console.error('Error en /accion:', err);
    res.status(500).json({ error: 'No se pudo aplicar la acción' });
  }
});

app.delete('/api/horarios/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();
  const before = data.horarios.length;
  data.horarios = data.horarios.filter(h => String(h.id) !== String(id));
  writeData(data);
  res.json({ ok: true, deleted: before - data.horarios.length });
});

/* ----------------------- ALIAS /admin -> /api (para tu UI) -------------- */
// Tu panel usa rutas /admin/...; las mapeamos a la API existente:

app.get('/admin/horarios', (req, res) => {
  req.url = '/api/horarios';
  app._router.handle(req, res, () => {});
});
app.post('/admin/horarios', (req, res) => {
  req.url = '/api/horarios';
  app._router.handle(req, res, () => {});
});
app.put('/admin/horarios/:id/estado', (req, res) => {
  req.url = `/api/horarios/${req.params.id}/estado`;
  app._router.handle(req, res, () => {});
});
app.post('/admin/horarios/:id/accion', (req, res) => {
  req.url = `/api/horarios/${req.params.id}/accion`;
  app._router.handle(req, res, () => {});
});
app.delete('/admin/horarios/:id', (req, res) => {
  req.url = `/api/horarios/${req.params.id}`;
  app._router.handle(req, res, () => {});
});

/* ------------------------- MERCADO PAGO INTEGRACIÓN ---------------------- */
if (!process.env.MP_ACCESS_TOKEN) {
  console.warn('⚠️ Falta MP_ACCESS_TOKEN en variables de entorno.');
}

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN || ''
});

app.post('/api/mp/preference', async (req, res) => {
  try {
    const {
      title = 'Inscripción PauPau',
      quantity = 1,
      unit_price = 1,
      currency_id = 'ARS',
      description = 'Pago de inscripción',
      metadata = {}
    } = req.body || {};

    const success = process.env.MP_SUCCESS_URL || 'https://paupaulanguages.com/pago-exitoso';
    const failure = process.env.MP_FAILURE_URL || 'https://paupaulanguages.com/pago-rechazado';
    const pending = process.env.MP_PENDING_URL || 'https://paupaulanguages.com/pago-pendiente';

    const pref = await mercadopago.preferences.create({
      items: [{ title, quantity, currency_id, unit_price, description }],
      back_urls: { success, failure, pending },
      auto_return: 'approved',
      metadata
    });

    res.json({
      ok: true,
      id: pref.body.id,
      init_point: pref.body.init_point,
      sandbox_init_point: pref.body.sandbox_init_point
    });
  } catch (err) {
    console.error('Error creando preferencia MP:', err?.response?.body || err);
    res.status(500).json({ error: 'No se pudo crear la preferencia' });
  }
});

app.post('/api/mp/webhook', async (req, res) => {
  try {
    res.sendStatus(200);
    const { type, data } = req.body || {};
    if (type !== 'payment' || !data?.id) return;

    const meta = req.body?.metadata || null;
    const horarioId = meta?.horarioId;
    if (!horarioId) return;

    const file = readData();
    const h = findHorario(file.horarios, horarioId);
    if (!h) return;
    h.estado = 'bloqueado';
    writeData(file);
    console.log('⌁ Webhook: bloqueado horario', horarioId);
  } catch (err) {
    console.error('Error en webhook MP:', err);
  }
});

/* --------------------------------- START -------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor escuchando en :' + PORT);
  console.log('CORS Orígenes permitidos:', ORIGINS);
});
