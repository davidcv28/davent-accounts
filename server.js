/* Servicio de cuentas + addon Xtream gateada.

   Rutas:
     Admin (header X-Admin-Key):
       POST   /api/admin/coupons        {days, screens, note} → crea cupón
       GET    /api/admin/coupons        → lista
       DELETE /api/admin/coupons/:code  → revoca
       GET    /api/admin/xtream-status  → panel/catálogo actual
     App (por dispositivo):
       POST   /api/auth                 {code, deviceId, name} → valida+activa
                                          (devuelve debridRequired/Configured)
       GET    /api/status?code=X        → estado de la cuenta
       POST   /api/screens/acquire      {code, deviceId} → toma/renueva pantalla
       POST   /api/screens/heartbeat    {code, deviceId} → alias de acquire
       POST   /api/screens/release      {code, deviceId} → suelta
       GET    /api/debrid?code=X        → {service, apiKeyHint}
       PUT    /api/debrid               {code, service, apiKey}
       DELETE /api/debrid?code=X
     Addon Stremio (token = cupón en la URL):
       GET /addon/:token/manifest.json
       GET /addon/:token/stream/:type/:id.json   id = ttXXX, tmdb:N o ttXXX:S:E
       → sin debrid configurada devuelve stream-aviso davent://needs-debrid
         (REQUIRE_DEBRID=0 lo desactiva) */
const http = require('http');
const crypto = require('crypto');
const accounts = require('./accounts');
const xtream = require('./xtream');
const db = require('./db');

const PORT = Number(process.env.PORT || 7802);
const BIND = process.env.BIND || '0.0.0.0';

/* Admin key: env > persistida en db > generada al primer boot. */
function adminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('admin_key');
  if (row) return row.v;
  const k = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO meta (k,v) VALUES (?,?)').run('admin_key', k);
  return k;
}
const ADMIN_KEY = adminKey();

/* Debrid obligatoria: el usuario entra SU key antes de que el addon sirva
   streams (cada cuenta resuelve con su propio servicio, no hay key global).
   Desactivable con REQUIRE_DEBRID=0 para pruebas. */
const REQUIRE_DEBRID = process.env.REQUIRE_DEBRID !== '0';

const MANIFEST = {
  id: 'davent.xtream.latino',
  version: '1.0.0',
  name: 'Davent Xtream Latino',
  description: 'Películas y series en latino/castellano vía paneles Xtream (pool VegetaTV). Requiere cupón activo.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb:'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(body);
}

const readBody = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(d || '{}'));
      } catch (_) {
        resolve({});
      }
    });
  });

const srv = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;

    /* Salud pública (Render healthCheck + keep-alive externo): sin datos
       sensibles, solo vivo/muerto y cuándo se sincronizó el catálogo. */
    if (path === '/health' || path === '/healthz') {
      const cat = (db.prepare("SELECT v FROM meta WHERE k='catalog_at'").get() || {}).v || '0';
      return send(res, 200, { ok: true, catalogAt: Number(cat) });
    }

    /* ---------- admin ---------- */
    if (path.startsWith('/api/admin/')) {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'unauthorized' });
      if (path === '/api/admin/coupons' && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, accounts.createCoupon(b));
      }
      if (path === '/api/admin/coupons' && req.method === 'GET') return send(res, 200, { coupons: accounts.listCoupons() });
      const dm = /^\/api\/admin\/coupons\/([^/]+)$/.exec(path);
      if (dm && req.method === 'DELETE') return send(res, accounts.revoke(dm[1]) ? 200 : 404, { ok: true });
      if (path === '/api/admin/xtream-status') {
        const meta = (k) => (db.prepare('SELECT v FROM meta WHERE k=?').get(k) || {}).v || null;
        return send(res, 200, {
          panels: JSON.parse(meta('panels') || '[]').map((p) => `${p.flag || ''} ${p.base} (max ${p.maxCon || '?'})`),
          catalogAt: Number(meta('catalog_at') || 0),
          vodCount: db.prepare('SELECT COUNT(*) n FROM vod').get().n,
          seriesCount: db.prepare('SELECT COUNT(*) n FROM series_index').get().n,
          perPanel: db.prepare('SELECT panel_key, COUNT(*) n FROM vod GROUP BY panel_key').all(),
        });
      }
      return send(res, 404, { error: 'not_found' });
    }

    /* ---------- app ---------- */
    if (path === '/api/auth' && req.method === 'POST') {
      const b = await readBody(req);
      const r = accounts.auth(b.code, b.deviceId, b.name);
      if (r.ok) {
        r.debridRequired = REQUIRE_DEBRID;
        r.debridConfigured = !!accounts.getDebrid(b.code);
      }
      return send(res, r.ok ? 200 : 403, r);
    }
    if (path === '/api/status' && req.method === 'GET') {
      const code = u.searchParams.get('code');
      const st = accounts.validateToken(code);
      if (st) {
        st.debridRequired = REQUIRE_DEBRID;
        st.debridConfigured = !!accounts.getDebrid(code);
      }
      return send(res, st ? 200 : 403, st || { error: 'invalid_or_expired' });
    }
    /* acquire = también es el heartbeat: re-adquirir un deviceId ya tomado
       renueva su lease (SCREEN_TTL_MS). /heartbeat es alias explícito. */
    if ((path === '/api/screens/acquire' || path === '/api/screens/heartbeat') && req.method === 'POST') {
      const b = await readBody(req);
      const r = accounts.acquireScreen(b.code, b.deviceId);
      return send(res, r.ok ? 200 : 409, r);
    }
    if (path === '/api/screens/release' && req.method === 'POST') {
      const b = await readBody(req);
      accounts.releaseScreen(b.code, b.deviceId);
      return send(res, 200, { ok: true });
    }
    if (path === '/api/debrid') {
      const b = req.method === 'PUT' ? await readBody(req) : {};
      const code = u.searchParams.get('code') || b.code;
      if (req.method === 'GET') {
        const d = accounts.getDebrid(code);
        return send(res, d ? 200 : 404, d || { configured: false });
      }
      if (req.method === 'PUT') {
        const r = accounts.setDebrid(code, b.service, b.apiKey);
        return send(res, r.ok ? 200 : 403, r);
      }
      if (req.method === 'DELETE') {
        accounts.delDebrid(code);
        return send(res, 200, { ok: true });
      }
    }

    /* ---------- addon stremio (gateada por token) ---------- */
    const am = /^\/addon\/([^/]+)\/(.+)$/.exec(path);
    if (am) {
      const token = am[1];
      const sub = am[2];
      if (!accounts.validateToken(token)) {
        return send(res, 403, sub === 'manifest.json' ? { ...MANIFEST, name: 'Davent Xtream (cupón inválido o vencido)' } : { streams: [] });
      }
      if (sub === 'manifest.json') return send(res, 200, MANIFEST);
      const sm = /^stream\/(movie|series)\/(.+)\.json$/.exec(sub);
      if (sm) {
        if (REQUIRE_DEBRID && !accounts.getDebrid(token)) {
          return send(res, 200, {
            streams: [
              {
                name: 'Davent',
                title: 'Configurá tu debrid para usar el addon (PUT /api/debrid)',
                url: 'davent://needs-debrid',
              },
            ],
            debridRequired: true,
          });
        }
        const t0 = Date.now();
        const streams = await xtream.resolve(sm[1], decodeURIComponent(sm[2]));
        console.log(`[xtream] ${sm[1]} ${sm[2]} → ${streams.length} streams (${Date.now() - t0}ms)`);
        return send(res, 200, { streams });
      }
      return send(res, 404, { streams: [] });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.log('[davent] error:', e && e.stack);
    return send(res, 500, { error: 'internal' });
  }
});

srv.listen(PORT, BIND, () => {
  console.log(`[davent-accounts] escuchando en ${BIND}:${PORT}`);
  console.log(`[davent-accounts] ADMIN_KEY=${ADMIN_KEY}`);
  /* Warm-up: descubrir panel + sincronizar catálogo en background. */
  xtream.pickPanel().catch((e) => console.log('[xtream] warm-up:', e.message));
});
