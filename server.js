// ===== CORS robusto (permite www y sin www, y registra la lista) =====
const rawAllowed = process.env.ALLOWED_ORIGIN || '';
// Lista original (tal cual env var)
const allowList = rawAllowed.split(',').map(s => s.trim()).filter(Boolean);

// Normaliza a "host" (sin http/https, sin barra final y sin 'www.')
const normHost = (s) => {
  try {
    const u = new URL(s);
    return (u.hostname || '').replace(/^www\./, '');
  } catch {
    return String(s)
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/^www\./, '');
  }
};

// Set con los hosts permitidos
const allowedHosts = new Set(allowList.map(normHost));

// Log útil para que lo veas en Render → Logs
console.log('AllowList CORS (raw):', allowList);
console.log('AllowList CORS (hosts):', Array.from(allowedHosts));

app.use(cors({
  origin: (origin, cb) => {
    // Permite herramientas sin Origin (curl/Postman)
    if (!origin) return cb(null, true);

    let host;
    try {
      host = new URL(origin).hostname;
    } catch {
      host = origin;
    }
    const normalized = (host || '').replace(/^www\./, '');

    const ok = allowedHosts.has(normalized);
    if (ok) return cb(null, true);

    console.error('CORS bloqueado para:', origin, '— allowedHosts:', Array.from(allowedHosts));
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

