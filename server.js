// server.js
// Node 18+
// MP SDK v1.5.17
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');

const app = express();

/* ----------------------------- CONFIG BÁSICA ----------------------------- */

// CORS: tus dominios (podés sumar más en ALLOWED_ORIGINS, separados por coma)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// fallback con los 3 dominios que me diste
const DEFAULT_ORIGINS = [
  'https://paupaulanguages.com',
  'https://www.paupaulanguages.com',
  'https://paupaulanguages.odoo.com'
];

const ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ALLOWED_ORIGINS])];

app.use(cors({
  origin: function (origin, cb) {
    // permitir también requests del mismo host (SSR, curl, health, etc.)
    if (!origin) return cb(null, true);
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin no permitido: ' + origin));
  },
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Healthcheck simple
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------------------------- ALMACÉN HORARIOS --------------------------- */
// Guardamos en un JSON local para evitar 500. (En Render es efímero,
// pero alcanza para que las rutas no rompan. Luego podés cambiar a DB.)

const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.horarios)) parsed.horarios = [];
    return parsed;
  } catch {
    return { horarios: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function findHorario(horarios, id) {
  return horarios.find(h => String(h.id) === String(id));
}

// estados válidos para el sistema
const ESTADOS_VALIDOS = ['pendiente', 'disponible', 'bloqueado'];

/* -------------------------- ENDPOINTS DE HORARIOS ------------------------ */

// Listar horarios (para tu panel)
app.get('/api/horarios', (req, res) => {
  const data = readData();
  res.json({ horarios: data.horarios });
});

// Crear un horario rápido (opcional para pruebas)
app.post('/api/horarios', (req, res) => {
  const { dia = 'Lunes', hora = '15:00', estado = 'disponible' } = req.body || {};
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const data = readData();
  const id = Date.now().toString();
  const nuevo = { id, dia, hora, estado };
  data.horarios.push(nuevo);
  writeData(data);
  res.json({ ok: true, horario: nuevo });
});

// Cambiar estado por endpoint explícito
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

    return res.json({ ok: true, id, estado: h.estado });
  } catch (err) {
    console.error('Error al actualizar estado:', err);
    return res.status(500).json({ error: 'No se pudo actualizar el estado' });
  }
});

// Cambiar estado por "acción" (para tu dropdown de acciones)
app.post('/api/horarios/:id/accion', (req, res) => {
  try {
    const { id } = req.params;
    const { accion } = req.body || {};
    if (!accion) return res.status(400).json({ error: 'Falta accion' });

    // Mapear acciones del UI a estados
    const map = {
      bloquear: 'bloqueado',
      liberar: 'disponible',
      disponible: 'disponible',
      pendiente: 'pendiente',
      // por si tu UI manda el mismo texto que el estado
      bloqueado: 'bloqueado'
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

    return res.json({ ok: true, id, estado: h.estado });
  } catch (err) {
    console.error('Error en /accion:', err);
    return res.status(500).json({ error: 'No se pudo aplicar la acción' });
  }
});

// Borrar horario
app.delete('/api/horarios/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();
  const before = data.horarios.length;
  data.horarios = data.horarios.filter(h => String(h.id) !== String(id));
  writeData(data);
  res.json({ ok: true, deleted: before - data.horarios.length });
});

/* ------------------------- MERCADO PAGO INTEGRACIÓN ---------------------- */

if (!process.env.MP_ACCESS_TOKEN) {
  console.warn('⚠️ Falta MP_ACCESS_TOKEN en .env');
}

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN || ''
});

// Crear preferencia
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

    // back_urls (podés sobreescribirlas desde el cliente si querés)
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

// Webhook (notifica pagos y, si querés, bloquea el cupo automáticamente)
app.post('/api/mp/webhook', async (req, res) => {
  try {
    // MP pega varias veces; respondemos 200 rápido
    res.sendStatus(200);

    const { type, data } = req.body || {};
    if (type !== 'payment' || !data?.id) return;

    // Podrías consultar el pago acá si necesitás
    // const pago = await mercadopago.payment.findById(data.id);

    // Si mandás en metadata el id del horario, lo bloqueamos al aprobarse
    // (hacer tu propia validación de estado del pago si lo deseás)
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
