/* Lógica de cuentas: cupones, auth, pantallas (lease con heartbeat) y
   debrid por usuario.

   Modelo de cupón:
   - El admin genera un código (ej. DVNT-8F3K-2QZM) con days + max_screens.
   - Primer login de un dispositivo = activación: el reloj de `days` empieza
     ahí (activated_at), no al crear el cupón — un cupón sin usar no vence.
   - Token de sesión = el propio code (el addon lo lleva en la URL); el
     deviceId identifica la pantalla.

   Pantallas:
   - Un "screen" es un lease de SCREEN_TTL_MS que el player renueva por
     heartbeat mientras reproduce. acquireScreen() da slot si hay libre;
     si no, 409 — el 4to dispositivo reproduce nada hasta que otro lease
     expire. Los leases vencidos se perezan solos en cada lectura. */
const crypto = require('crypto');
const db = require('./db');

const SCREEN_TTL_MS = 90e3;
const MAX_SCREENS_CAP = 3;

const q = {
  getAcc: db.prepare('SELECT * FROM accounts WHERE code = ?'),
  createAcc: db.prepare(
    'INSERT INTO accounts (code, days, max_screens, note, created_at) VALUES (?,?,?,?,?)'
  ),
  activate: db.prepare(
    'UPDATE accounts SET activated_at = ? WHERE code = ? AND activated_at IS NULL'
  ),
  revoke: db.prepare('UPDATE accounts SET revoked = ? WHERE code = ?'),
  listAcc: db.prepare('SELECT * FROM accounts ORDER BY created_at DESC'),
  upDevice: db.prepare(
    `INSERT INTO devices (account_code, device_id, name, first_seen, last_seen)
     VALUES (?,?,?,?,?)
     ON CONFLICT(account_code, device_id) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name`
  ),
  countDevices: db.prepare('SELECT COUNT(*) n FROM devices WHERE account_code = ?'),
  pruneScreens: db.prepare('DELETE FROM screens WHERE lease_until < ?'),
  activeScreens: db.prepare('SELECT device_id FROM screens WHERE account_code = ? AND lease_until >= ?'),
  getLease: db.prepare('SELECT lease_until FROM screens WHERE account_code = ? AND device_id = ?'),
  setLease: db.prepare(
    `INSERT INTO screens (account_code, device_id, lease_until) VALUES (?,?,?)
     ON CONFLICT(account_code, device_id) DO UPDATE SET lease_until = excluded.lease_until`
  ),
  delLease: db.prepare('DELETE FROM screens WHERE account_code = ? AND device_id = ?'),
  setDebrid: db.prepare(
    `INSERT INTO debrid (account_code, service, api_key, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(account_code) DO UPDATE SET service = excluded.service, api_key = excluded.api_key, updated_at = excluded.updated_at`
  ),
  getDebrid: db.prepare('SELECT service, api_key, updated_at FROM debrid WHERE account_code = ?'),
  delDebrid: db.prepare('DELETE FROM debrid WHERE account_code = ?'),
};

function newCode() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DVNT-${seg()}-${seg()}`;
}

function expiresAt(acc) {
  if (!acc.activated_at) return null; // no activado: no vence todavía
  return acc.activated_at + acc.days * 86400e3;
}

/* Estado público de una cuenta. expired=true también para cupones que nunca
   se activaron (activated_at null → expired false, "sin activar"). */
function publicState(acc) {
  const exp = expiresAt(acc);
  const now = Date.now();
  return {
    code: acc.code,
    days: acc.days,
    maxScreens: Math.min(acc.max_screens, MAX_SCREENS_CAP),
    activated: !!acc.activated_at,
    expiresAt: exp,
    daysLeft: exp ? Math.max(0, Math.ceil((exp - now) / 86400e3)) : null,
    expired: exp !== null && now >= exp,
    revoked: !!acc.revoked,
    note: acc.note,
  };
}

/* Crea un cupón (admin). */
function createCoupon({ days = 30, screens = MAX_SCREENS_CAP, note = '' } = {}) {
  const code = newCode();
  q.createAcc.run(code, Math.max(1, days | 0), Math.min(screens, MAX_SCREENS_CAP), String(note).slice(0, 80), Date.now());
  return publicState(q.getAcc.get(code));
}

function listCoupons() {
  return q.listAcc.all().map(publicState);
}

function revoke(code, revoked = true) {
  const r = q.revoke.run(revoked ? 1 : 0, code);
  return r.changes > 0;
}

/* Auth de dispositivo: valida el cupón, lo activa si es la primera vez y
   registra el dispositivo. Devuelve {ok, error, account}. */
function auth(code, deviceId, deviceName = '') {
  const acc = q.getAcc.get(String(code || '').trim().toUpperCase());
  if (!acc) return { ok: false, error: 'invalid_code' };
  if (acc.revoked) return { ok: false, error: 'revoked' };
  const now = Date.now();
  if (!acc.activated_at) q.activate.run(now, acc.code); // el reloj empieza en el primer uso
  const st = publicState(q.getAcc.get(acc.code));
  if (st.expired) return { ok: false, error: 'expired', account: st };
  if (deviceId) q.upDevice.run(acc.code, String(deviceId).slice(0, 80), String(deviceName).slice(0, 60), now, now);
  return { ok: true, account: st };
}

/* Valida un token (el code) sin tocar activación — para el addon gateado. */
function validateToken(code) {
  const acc = q.getAcc.get(String(code || '').trim().toUpperCase());
  if (!acc || acc.revoked) return null;
  const st = publicState(acc);
  return st.expired ? null : st;
}

/* Screens: devuelve {ok, screens} o {ok:false, error:'screens_full', screens}. */
function acquireScreen(code, deviceId) {
  const acc = q.getAcc.get(String(code || '').trim().toUpperCase());
  if (!acc) return { ok: false, error: 'invalid_code' };
  const now = Date.now();
  q.pruneScreens.run(now);
  const cap = Math.min(acc.max_screens, MAX_SCREENS_CAP);
  const active = q.activeScreens.all(acc.code, now).map((r) => r.device_id);
  if (active.includes(deviceId)) {
    q.setLease.run(acc.code, String(deviceId).slice(0, 80), now + SCREEN_TTL_MS);
    return { ok: true, screens: active };
  }
  if (active.length >= cap) return { ok: false, error: 'screens_full', screens: active, maxScreens: cap };
  q.setLease.run(acc.code, String(deviceId).slice(0, 80), now + SCREEN_TTL_MS);
  return { ok: true, screens: [...active, deviceId], maxScreens: cap };
}

function releaseScreen(code, deviceId) {
  q.delLease.run(String(code || '').trim().toUpperCase(), String(deviceId || '').slice(0, 80));
}

function setDebrid(code, service, apiKey) {
  if (!validateToken(code)) return { ok: false, error: 'invalid_code' };
  q.setDebrid.run(String(code).trim().toUpperCase(), String(service || '').slice(0, 30), String(apiKey || '').slice(0, 200), Date.now());
  return { ok: true };
}

function getDebrid(code) {
  const r = q.getDebrid.get(String(code || '').trim().toUpperCase());
  if (!r) return null;
  return { service: r.service, apiKey: r.api_key, apiKeyHint: '••••' + r.api_key.slice(-4), updatedAt: r.updated_at };
}

function delDebrid(code) {
  q.delDebrid.run(String(code || '').trim().toUpperCase());
}

/* La key completa solo la usa el server internamente (proxy debrid) — nunca
   sale por API con más que el hint. */
function getDebridKey(code) {
  const r = q.getDebrid.get(String(code || '').trim().toUpperCase());
  return r ? { service: r.service, apiKey: r.api_key } : null;
}

module.exports = {
  createCoupon,
  listCoupons,
  revoke,
  auth,
  validateToken,
  acquireScreen,
  releaseScreen,
  setDebrid,
  getDebrid,
  delDebrid,
  getDebridKey,
  SCREEN_TTL_MS,
};
