/* CLI de administración de cupones.

   node admin.js new --days 30 --screens 3 --note "juan"   → crea cupón
   node admin.js list                                     → lista todos
   node admin.js revoke DVNT-XXXX-XXXX                    → revoca
   node admin.js unrevoke DVNT-XXXX-XXXX                  → rehabilita
   node admin.js key                                      → muestra ADMIN_KEY */
const accounts = require('./accounts');
const db = require('./db');

const [,, cmd, ...rest] = process.argv;
const opt = (name, dflt) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : dflt;
};

switch (cmd) {
  case 'new': {
    const c = accounts.createCoupon({
      days: Number(opt('days', 30)),
      screens: Number(opt('screens', 3)),
      note: opt('note', ''),
    });
    console.log('Cupón creado:', c.code, `| ${c.days} días | ${c.maxScreens} pantallas`, c.note ? `| ${c.note}` : '');
    break;
  }
  case 'list': {
    const rows = accounts.listCoupons();
    if (!rows.length) return console.log('(sin cupones)');
    for (const c of rows) {
      const estado = c.revoked ? 'REVOCADO' : c.expired ? 'VENCIDO' : !c.activated ? 'sin activar' : `${c.daysLeft}d restantes`;
      console.log(`${c.code}  ${String(c.days).padStart(3)}d  ${c.maxScreens}p  ${estado.padEnd(14)} ${c.note}`);
    }
    break;
  }
  case 'revoke':
  case 'unrevoke': {
    const code = rest[0];
    if (!code) return console.log('falta el código');
    console.log(accounts.revoke(code, cmd === 'revoke') ? 'ok' : 'no existe');
    break;
  }
  case 'key':
    console.log((db.prepare('SELECT v FROM meta WHERE k=?').get('admin_key') || {}).v || '(se genera en el primer arranque del server)');
    break;
  default:
    console.log('uso: node admin.js new|list|revoke|unrevoke|key');
}
