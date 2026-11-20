/* Provider Xtream latino via el pool de VegetaTV.

   Flujo:
   1. fetchServers() — bootstrap de VegetaTV devuelve una lista de paneles
      Xtream con credenciales gratuitas y bandera de país (🇲🇽 🇪🇸…). La lista
      se actualiza sola del lado de VegetaTV.
   2. pickPanel() — probea player_api.php de cada panel MX/ES y adopta el
      primero vivo; se cachea 6h. Si el panel muere → markBad → rota.
   3. syncCatalog() — baja get_vod_streams + get_series del panel (~30 MB)
      y los indexa en sqlite (name+year normalizados → stream_id, con
      variante latino/castellano según la categoría). Corre en background
      cada SYNC_MS o cuando el panel cambia.
   4. resolve() — Cinemeta convierte el imdb/tmdb id en título+año, el índice
      local matchea y la URL Xtream /movie|series/<u>/<p>/<id>.<ext> va directo
      al player (es HTTP abierto — no pasa por proxy ni sesión).

   Las credenciales son compartidas: un panel saturado/muerto se descarta y
   se prueba el siguiente de la lista — mismo patrón que el proxy-pool de
   Xuper. */
const db = require('./db');
const https = require('https');
const http = require('http');

const BOOTSTRAP_URL = 'http://vegetatvv2.duckdns.org/bootstrap.php';
const SYNC_MS = 6 * 3600e3;
const PANEL_TTL_MS = 6 * 3600e3;
const WANTED_FLAGS = new Set(['🇲🇽', '🇪🇸']); // latino/castellano primero
const CINEMETA = 'https://v3-cinemeta.strem.io';

const dbW = db.openWriter();
const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
const insVod = dbW.prepare('INSERT OR REPLACE INTO vod (stream_id, name, norm, year, ext, variant, panel_key) VALUES (?,?,?,?,?,?,?)');
const insSer = dbW.prepare('INSERT OR REPLACE INTO series_index (series_id, name, norm, year, panel_key) VALUES (?,?,?,?,?)');
/* Los stream_id/series_id son POR PANEL (PK compuesta). Los selects traen
   hits de TODOS los paneles indexados — el resolve filtra por los que
   sigan vivos y arma cada URL con las credenciales de SU panel. */
const selVod = db.prepare('SELECT * FROM vod WHERE norm = ?');
const selSer = db.prepare('SELECT * FROM series_index WHERE norm = ?');
const selVodLike = db.prepare('SELECT * FROM vod WHERE norm LIKE ? LIMIT 60');
const selSerLike = db.prepare('SELECT * FROM series_index WHERE norm LIKE ? LIMIT 60');
const wipeVod = dbW.prepare('DELETE FROM vod WHERE panel_key = ?');
const wipeSer = dbW.prepare('DELETE FROM series_index WHERE panel_key = ?');

function fetchText(url, { headers = {}, timeout = 15e3, maxBytes = 64e6 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, { headers, timeout, maxBytes }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) {
          req.destroy();
          return reject(new Error('respuesta demasiado grande'));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* Los dumps de catálogo son ~30-60 MB: un socket que corta a mitad no debe
   tirar todo el sync — un reintento simple alcanza en la práctica. */
async function fetchJson(url, opts = {}, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return JSON.parse(await fetchText(url, opts));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const yearOf = (name) => {
  /* OJO: con paréntesis m[0] es "(1999)" → usar el grupo capturado. */
  const m = /\(?(19\d{2}|20\d{2})\)?/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
};

/* Prefijo de idioma en el nombre: "EN ▎ The Matrix", "LAT | Matrix",
   "ES - Matrix". Es el marcador REAL del audio (más confiable que la
   categoría). Se extrae como variante y se stripea para el matching. */
const LANG_VARIANT = {
  ES: 'latino', LAT: 'latino', LATINO: 'latino', ESP: 'latino',
  'ESPAÑOL': 'latino', MX: 'latino', MULTI: 'latino',
  CAST: 'castellano', CASTELLANO: 'castellano',
  EN: 'ingles', ENG: 'ingles',
  SUB: 'subtitulado', VOSE: 'subtitulado', SUBTITULADO: 'subtitulado',
};
/* Prefijos aceptados: "EN ▎ T", "LAT | T", "ES - T" y el formato de
   zen8kk "┃ES┃ T" / "┃MULTI┃ T" (┃ es U+2503, no el ▎ de otros paneles).
   Los códigos NO españoles (NL/GR/DE/TR/AR/FR…) quedan sin mapear a
   propósito: su norm conserva el prefijo y no ensucia el matching. */
const langPrefix = (name) => {
  const m = /^[┃|▎·:\-\s]*([A-ZÑ]{2,12})\s*(?:┃|▎|\||·|-|:)\s*/.exec(String(name || ''));
  return m && LANG_VARIANT[m[1]] ? { lang: m[1], variant: LANG_VARIANT[m[1]], strip: m[0].length } : null;
};
const cleanName = (name) => {
  let n = String(name || '').trim();
  const p = langPrefix(n);
  if (p) n = n.slice(p.strip).trim();
  /* Sufijos tipo "Matrix (CAST) (1999)": saca todos los grupos
     paréntesis finales que sean marcador de idioma o año; frena en el
     primero que es contenido real ("(La La Land)"). */
  for (;;) {
    const m = /\(([^()]*)\)\s*$/.exec(n);
    if (!m) break;
    const inner = m[1].trim().toUpperCase();
    if (/^(19|20)\d{2}$/.test(inner) || LANG_VARIANT[inner]) {
      n = n.slice(0, m.index).trim();
      continue;
    }
    break;
  }
  return n;
};
const variantOfName = (name) => {
  const p = langPrefix(name);
  if (p) return p.variant;
  /* sufijo: "... (LAT) (1999)" → el lang está en alguno de los últimos
     grupos paréntesis */
  const ms = String(name || '').match(/\(([^()]*)\)\s*/g) || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    const inner = ms[i].slice(1, -1).trim().toUpperCase();
    if (LANG_VARIANT[inner]) return LANG_VARIANT[inner];
    if (!/^(19|20)\d{2}$/.test(inner)) break;
  }
  return null;
};
const VARIANT_ORDER = { latino: 0, castellano: 1, subtitulado: 2, ingles: 3 };

/* ---------- pool de paneles ---------- */

function parseServers(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /(https?:\/\/\S+)\s*(.*)/.exec(t);
    if (!m) continue;
    try {
      const u = new URL(m[1]);
      const p = u.pathname.toLowerCase();
      if (!p.endsWith('player_api.php') && !p.endsWith('get.php')) continue;
      const username = u.searchParams.get('username') || u.searchParams.get('user') || '';
      const password = u.searchParams.get('password') || u.searchParams.get('pass') || '';
      if (!username) continue;
      const flag = (m[2].match(/[\u{1F1E6}-\u{1F1FF}]{2}/u) || [''])[0];
      const key = u.host + '|' + username;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ base: u.protocol + '//' + u.host, username, password, flag, key });
    } catch (_) {}
  }
  return out;
}

async function fetchServers() {
  /* Version-code: el bootstrap exige el mínimo vigente; se arranca en 25 y
     si pide más se reintenta con el latest que devuelva. */
  let code = 25;
  for (let i = 0; i < 2; i++) {
    const headers = {
      'X-Vegeta-Version-Code': String(code),
      'X-Vegeta-Servers-Direct': '1',
      Accept: 'application/json',
    };
    const data = JSON.parse(await fetchText(`${BOOTSTRAP_URL}?v=${Date.now()}`, { headers }));
    if (data.ok === false) {
      const want = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
      if (i === 0 && want > code) {
        code = want;
        continue;
      }
      throw new Error('bootstrap rechazado');
    }
    let text = data.servers_text || '';
    if (!text.trim() && data.servers_url) {
      text = await fetchText(data.servers_url, { headers: { ...headers, Accept: 'text/plain' } });
    }
    const all = parseServers(text);
    /* MX primero (catálogo netamente latino), ES después (mezcla EN/ES),
       luego el resto como último recurso. */
    const rank = (s) => (s.flag === '🇲🇽' ? 0 : s.flag === '🇪🇸' ? 1 : WANTED_FLAGS.has(s.flag) ? 2 : 3);
    return [...all].sort((a, b) => rank(a) - rank(b));
  }
  throw new Error('bootstrap: sin servidores');
}

async function probePanel(srv) {
  try {
    const data = JSON.parse(
      await fetchText(`${srv.base}/player_api.php?username=${srv.username}&password=${encodeURIComponent(srv.password)}`, { timeout: 10e3 })
    );
    const u = data.user_info || {};
    if (String(u.auth) === '0' || String(u.status).toLowerCase() !== 'active') return null;
    /* Cuenta vencida: exp_date (unix) ya pasó → no sirve aunque auth dé ok. */
    if (u.exp_date && Number(u.exp_date) * 1000 < Date.now()) return null;
    return { ...srv, maxCon: Number(u.max_connections) || 1 };
  } catch (_) {
    return null;
  }
}

/* Pool multi-panel: cada panel vivo indexa su propio catálogo (panel_key)
   y el resolve emite UNA copia por panel por variante — más fuentes por
   título y redundancia real: si un panel se satura o muere, quedan los
   otros. PANEL_POOL limita la descarga (cada catálogo pesa ~30 MB). */
const PANEL_POOL = 3;
let livePanels = [];
let panelsAt = 0;

async function pickPanels() {
  if (livePanels.length && Date.now() - panelsAt < PANEL_TTL_MS) return livePanels;
  console.log('[xtream] buscando paneles vivos…');
  const servers = await fetchServers();
  const dead = getDead();
  /* Probe en paralelo del top de la lista (MX > ES > resto) — serial
     tardaba ~10 s por panel caído en el peor caso. */
  const candidates = servers.filter((s) => !dead.has(s.key)).slice(0, 14);
  const probed = await Promise.all(candidates.map(probePanel));
  const found = probed.filter(Boolean).slice(0, PANEL_POOL);
  if (!found.length) throw new Error('sin paneles vivos');
  livePanels = found;
  panelsAt = Date.now();
  setMeta.run('panels', JSON.stringify(found));
  setMeta.run('panel', JSON.stringify(found[0]));
  for (const p of found) {
    console.log(`[xtream] panel activo: ${p.base} (${p.flag || '?'}, max ${p.maxCon} conexiones)`);
  }
  syncCatalog().catch((e) => console.log('[xtream] sync error:', e.message));
  return found;
}
async function pickPanel() {
  return (await pickPanels())[0];
}

/* Paneles muertos con TTL: una cuenta caída puede revivir — se olvida
   a las 24 h para no condenarla para siempre. */
const DEAD_TTL_MS = 24 * 3600e3;
const getDead = () => {
  const list = JSON.parse((getMeta.get('dead_panels') || {}).v || '[]');
  const fresh = list.filter((d) => Date.now() - d.t < DEAD_TTL_MS);
  if (fresh.length !== list.length) setMeta.run('dead_panels', JSON.stringify(fresh));
  return new Set(fresh.map((d) => d.k));
};
function markBad(key) {
  const target = key ? livePanels.find((p) => p.key === key) : livePanels[0];
  if (!target) return;
  const list = JSON.parse((getMeta.get('dead_panels') || {}).v || '[]').filter((d) => d.k !== target.key);
  list.push({ k: target.key, t: Date.now() });
  setMeta.run('dead_panels', JSON.stringify(list.slice(-50)));
  livePanels = livePanels.filter((p) => p.key !== target.key);
  failCount.delete(target.key);
  setMeta.run('panels', JSON.stringify(livePanels));
  console.log(`[xtream] panel descartado: ${target.base}`);
  /* Pool vacío → el próximo pickPanels re-probea (panelsAt en 0). */
  if (!livePanels.length) panelsAt = 0;
}

/* Fallos consecutivos por panel: un get_series_info que timeout durante un
   sync de 30 MB NO es panel muerto — 3 strikes seguidos sí lo es. */
const failCount = new Map();
const failPanel = (key) => {
  const n = (failCount.get(key) || 0) + 1;
  failCount.set(key, n);
  if (n >= 3) markBad(key);
};
const okPanel = (key) => failCount.delete(key);

/* ---------- catálogo ---------- */

let syncPromise = null;
function syncCatalog() {
  /* Single-flight que DEVUELVE la promise en vuelo: un resolve durante
     el sync la espera en vez de resolver con índice vacío/viejo.
     Sincroniza cada panel vivo que esté vencido, secuencial (los dumps
     son pesados — en paralelo saturarían memoria y los paneles). */
  if (syncPromise) return syncPromise;
  if (!livePanels.length) return Promise.resolve();
  syncPromise = (async () => {
    for (const p of [...livePanels]) {
      const last = Number((getMeta.get(`catalog_at:${p.key}`) || {}).v || 0);
      if (Date.now() - last < SYNC_MS) continue;
      await doSync(p);
    }
    setMeta.run('catalog_at', String(Date.now()));
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}
async function doSync(p) {
  try {
    const creds = `username=${p.username}&password=${encodeURIComponent(p.password)}`;
    /* Variante por categoría: "(LAT)" → latino, "(CAST)" → castellano. */
    const cats = await fetchJson(`${p.base}/player_api.php?${creds}&action=get_vod_categories`, { maxBytes: 8e6 });
    const variantOf = {};
    for (const c of cats) {
      const n = String(c.category_name || '');
      variantOf[c.category_id] = /\(CAST\)/i.test(n) ? 'castellano' : 'latino';
    }
    const catIds = new Set(cats.filter((c) => /\(LAT\)|\(CAST\)/i.test(c.category_name)).map((c) => String(c.category_id)));

    console.log(`[xtream] sincronizando catálogo de ${p.base}…`);
    const vod = await fetchJson(`${p.base}/player_api.php?${creds}&action=get_vod_streams`, { timeout: 120e3, maxBytes: 128e6 }, 3);
    dbW.exec('BEGIN');
    try {
      /* Wipe SOLO de este panel: el índice de los demás queda intacto. */
      wipeVod.run(p.key);
      for (const it of vod) {
        const cid = String(it.category_id ?? (it.category_ids || [])[0] ?? '');
        if (catIds.size && !catIds.has(cid)) continue;
        const nm = String(it.name || '');
        const clean = cleanName(nm);
        insVod.run(
          Number(it.stream_id),
          nm,
          norm(clean),
          yearOf(nm),
          String(it.container_extension || 'mp4'),
          variantOfName(nm) || variantOf[cid] || 'latino',
          p.key
        );
      }
      dbW.exec('COMMIT');
    } catch (e) {
      dbW.exec('ROLLBACK');
      throw e;
    }
    console.log(`[xtream] ${p.base}: ${vod.length} películas indexadas`);

    const series = await fetchJson(`${p.base}/player_api.php?${creds}&action=get_series`, { timeout: 120e3, maxBytes: 128e6 }, 3);
    dbW.exec('BEGIN');
    try {
      wipeSer.run(p.key);
      for (const it of series) {
        const nm = String(it.name || '');
        insSer.run(
          Number(it.series_id),
          nm,
          norm(cleanName(nm)),
          yearOf(nm),
          p.key
        );
      }
      dbW.exec('COMMIT');
    } catch (e) {
      dbW.exec('ROLLBACK');
      throw e;
    }
    console.log(`[xtream] ${p.base}: ${series.length} series indexadas`);

    setMeta.run(`catalog_at:${p.key}`, String(Date.now()));
  } catch (e) {
    console.log(`[xtream] sync falló (${p.base}):`, e.message);
    failPanel(p.key);
  }
}

/* ---------- matching ---------- */

/* El panel nombra en español; el imdb id llega con el título original.
   TMDB da los títulos localizados (es-MX/es) + el original — todos se prueban
   como variantes de matcheo. La key viene de TMDB_API_KEY o del .env del repo
   principal (misma máquina). Cinemeta queda de respaldo sin key. */
let TMDB_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_KEY) {
  try {
    const envTxt = require('fs').readFileSync(require('path').join(__dirname, '..', 'NetflixPersonal', '.env'), 'utf8');
    const m = /TMDB_API_KEY\s*=\s*"?([A-Za-z0-9]+)"?/.exec(envTxt);
    if (m) TMDB_KEY = m[1];
  } catch (_) {}
}
async function lookupTitle(type, imdbId) {
  const names = [];
  let year = null;
  let tmdbId = /^tmdb:(\d+)$/.exec(imdbId)?.[1] || null;
  if (TMDB_KEY && /^tt\d+$/.test(imdbId)) {
    try {
      const f = await fetchJson(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=es-MX`
      );
      const r = (type === 'movie' ? f.movie_results : f.tv_results) || [];
      if (r[0]) {
        names.push(r[0].title || r[0].name, r[0].original_title || r[0].original_name);
        if (!tmdbId) tmdbId = r[0].id;
        year = yearOf(r[0].release_date || r[0].first_air_date || '');
      }
    } catch (_) {}
  }
  /* Detalle + translations en un call: da el nombre es-MX, el original y
     TODAS las traducciones. Imprescindible — los paneles nombran con el
     título internacional ("┃ES┃ Doctor X: Mafia in White") aunque el
     es-MX de TMDB sea "Doctora X", y Cinemeta a veces no tiene el id. */
  if (TMDB_KEY && tmdbId) {
    try {
      const r = await fetchJson(
        `https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${TMDB_KEY}&language=es-MX&append_to_response=translations`
      );
      names.push(r.title || r.name, r.original_title || r.original_name);
      if (!year) year = yearOf(r.release_date || r.first_air_date || '');
      for (const t of r.translations?.translations || []) {
        if (t.iso_639_1 === 'es' || t.iso_639_1 === 'en') {
          names.push(t.data?.name || t.data?.title);
        }
      }
    } catch (_) {}
  }
  try {
    const data = await fetchJson(`${CINEMETA}/meta/${type}/${imdbId}.json`);
    const meta = (data && data.meta) || {};
    if (meta.name) names.push(meta.name);
    if (!year) year = yearOf(meta.year || meta.released || '');
    (meta.aliases || []).forEach((a) => names.push(a));
  } catch (_) {}
  return { names: [...new Set(names.filter(Boolean))], year };
}

const nameVariants = (name) => {
  /* El panel nombra en español; el imdb id viene con el nombre original.
     Probamos el nombre tal cual y sin subtítulos tras ":" o "-". */
  const n = norm(name);
  const short = norm(name.split(/[:–-]/)[0]);
  return [...new Set([n, short].filter(Boolean))];
};

function matchRows(rows, year) {
  if (!rows.length) return null;
  if (year) {
    const exact = rows.filter((r) => r.year === year);
    if (exact.length) return exact;
    const near = rows.filter((r) => r.year && Math.abs(r.year - year) <= 1);
    if (near.length) return near;
  }
  return rows;
}

const streamUrl = (p, kind, id, ext) =>
  `${p.base}/${kind}/${p.username}/${encodeURIComponent(p.password)}/${id}.${ext || 'mp4'}`;

/* ---------- resolve ---------- */

const STREAM_DEADLINE_MS = 18e3;

async function doResolve(kind, id) {
  const panels = await pickPanels();
  /* Panel dueño de cada hit: el stream_id/series_id solo sirve con las
     credenciales del panel que lo indexó. Filas de paneles ya muertos
     (no en livePanels) se descartan acá. */
  const pmap = new Map(panels.map((p) => [p.key, p]));
  const panelOf = (row) => pmap.get(row.panel_key);
  const syncP = syncCatalog().catch(() => {});

  const em = /^(.*):(\d+):(\d+)$/.exec(id);
  const type = kind === 'movie' ? 'movie' : 'series';
  const imdbId = em ? em[1] : id;
  const season = em ? Number(em[2]) : 1;
  const episode = em ? Number(em[3]) : 1;

  const title = await lookupTitle(type, imdbId);
  if (!title.names.length) return [];
  const variants = [...new Set(title.names.flatMap(nameVariants))];

  await Promise.race([syncP, new Promise((r) => setTimeout(r, STREAM_DEADLINE_MS - 4000))]);

  const LABEL = { latino: 'Latino', castellano: 'Castellano', subtitulado: 'VOSE', ingles: 'Inglés' };
  const audioOf = (v) => (v === 'latino' || v === 'castellano' ? 'es' : 'en');

  /* Interleave por panel dentro de cada variante: con 3 paneles y cupo
     limitado en el resolver, round-robin reparte los sondeos entre
     paneles distintos en vez de gastarlos todos en el primero. */
  const interleave = (rows, variantOfRow) => {
    const buckets = new Map();
    for (const r of rows) {
      const v = variantOfRow(r);
      if (!buckets.has(v)) buckets.set(v, new Map());
      const bp = buckets.get(v);
      if (!bp.has(r.panel_key)) bp.set(r.panel_key, []);
      bp.get(r.panel_key).push(r);
    }
    const order = Object.keys(VARIANT_ORDER).sort(
      (a, b) => VARIANT_ORDER[a] - VARIANT_ORDER[b],
    );
    const out = [];
    for (const v of order) {
      const bp = buckets.get(v);
      if (!bp) continue;
      /* Panel primero = el mejor rankeado del pool (orden de livePanels). */
      const queues = panels.map((p) => bp.get(p.key)).filter(Boolean);
      while (queues.some((q) => q.length)) {
        for (const q of queues) if (q.length) out.push(q.shift());
      }
    }
    return out;
  };

  if (type === 'movie') {
    /* Mergea hits de TODAS las variantes de nombre (dedupe por
       panel+stream_id: el mismo id en otro panel es OTRA copia válida). */
    const seen = new Set();
    let hits = [];
    for (const nv of variants) {
      for (const r of selVod.all(nv)) {
        const k = `${r.panel_key}|${r.stream_id}`;
        if (!seen.has(k) && panelOf(r)) { seen.add(k); hits.push(r); }
      }
    }
    /* Fallback difuso: "la ciudad de las estrellas (la la land)" no
       matchea exacto con "la la land"; LIKE %variante% lo encuentra y
       el año desambigua (matrix 1999 vs reloaded 2003). */
    if (!hits.length) {
      for (const nv of variants) {
        if (nv.length < 5) continue;
        for (const r of selVodLike.all(`%${nv}%`)) {
          const k = `${r.panel_key}|${r.stream_id}`;
          if (!seen.has(k) && panelOf(r)) { seen.add(k); hits.push(r); }
        }
      }
    }
    hits = interleave(matchRows(hits, title.year) || [], (r) => r.variant);
    /* Sin notWebReady: las URLs son directas, no necesitan headers. El MKV
       no lo decodifica el navegador pero eso lo demuele el CLIENTE
       (isBrowserUnplayable) — marcarlo acá hacía que el server lo skipee
       entero y nunca llegara a la APK, que sí lo reproduce. */
    return hits.slice(0, 12).map((h) => {
      const p = panelOf(h);
      return {
        name: `Xtream · ${LABEL[h.variant] || 'Latino'}`,
        title: `${h.name} · ${h.ext.toUpperCase()}`,
        url: streamUrl(p, 'movie', h.stream_id, h.ext),
        audioLang: audioOf(h.variant),
        variant: h.variant,
      };
    });
  }

  /* series: recolecta candidatas de todos los paneles, ordena latino
     primero intercalando paneles, y toma el episodio de CADA serie que
     lo tenga — una fuente por panel (varias copias = failover real). */
  const seen = new Set();
  let sers = [];
  for (const nv of variants) {
    for (const r of selSer.all(nv)) {
      const k = `${r.panel_key}|${r.series_id}`;
      if (!seen.has(k) && panelOf(r)) { seen.add(k); sers.push(r); }
    }
  }
  if (!sers.length) {
    for (const nv of variants) {
      if (nv.length < 5) continue;
      for (const r of selSerLike.all(`%${nv}%`)) {
        const k = `${r.panel_key}|${r.series_id}`;
        if (!seen.has(k) && panelOf(r)) { seen.add(k); sers.push(r); }
      }
    }
  }
  sers = interleave(matchRows(sers, title.year) || [], (r) => variantOfName(r.name) || 'latino');
  const out = [];
  /* get_series_info es un fetch por candidata — cap a 6 para no comerse
     el deadline si el título matchea de más. Error → marca ESE panel y
     sigue con la siguiente (no se cae todo el resolve). */
  for (const ser of sers.slice(0, 6)) {
    const p = panelOf(ser);
    if (!p) continue;
    let info;
    try {
      info = JSON.parse(
        await fetchText(`${p.base}/player_api.php?username=${p.username}&password=${encodeURIComponent(p.password)}&action=get_series_info&series_id=${ser.series_id}`, { timeout: 12e3, maxBytes: 32e6 })
      );
    } catch (_) {
      failPanel(p.key);
      continue;
    }
    okPanel(p.key);
    const eps = (info.episodes && info.episodes[String(season)]) || [];
    const ep = eps.find((x) => Number(x.episode_num) === episode) || eps[episode - 1];
    if (!ep) continue;
    const ext = ep.container_extension || 'mp4';
    const v = variantOfName(ser.name) || 'latino';
    out.push({
      name: `Xtream · ${LABEL[v] || 'Latino'}`,
      title: `${ser.name} S${season}E${episode} · ${ext.toUpperCase()}`,
      url: streamUrl(p, 'series', ep.id, ext),
      audioLang: audioOf(v),
      variant: v,
    });
  }
  return out.slice(0, 12);
}

async function resolve(kind, id) {
  try {
    return await Promise.race([
      doResolve(kind, id),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadline')), STREAM_DEADLINE_MS)),
    ]);
  } catch (e) {
    /* Un timeout de TMDB/Cinemeta o el deadline NO es culpa del panel —
       ya no se marca malo acá (lo hacen los strikes de failPanel). Un
       retry cubre el fallo transitorio sin nukear el pool. */
    if (/deadline|HTTP|timeout|ECONN|reset|sin paneles/i.test(String(e && e.message))) {
      try {
        return await doResolve(kind, id);
      } catch (_) {}
    }
    return [];
  }
}

module.exports = { resolve, pickPanel, syncCatalog, fetchServers };
