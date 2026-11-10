// Временная диагностика (удалить): структура «Плоский отчет - полная» и товары Грин бим 2.0.
// Названия точек и людей в лог не пишутся.
'use strict';
const fs = require('fs');
const path = require('path');
const dcs = require('../src/dcs');
const rules1c = require('../src/rules1c');

const exp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const partnerNames = new Set((exp.partners || []).map(p => String(p.name || '').trim().toLowerCase()));
const userNames = new Set((exp.users || []).map(u => String(u.name || '').trim().toLowerCase()));
const mask = v => { const s = String(v == null ? '' : v).trim(); const l = s.toLowerCase(); return partnerNames.has(l) ? '<ТОЧКА>' : userNames.has(l) ? '<ЧЕЛ>' : s.slice(0, 90); };

console.log('== keys:', Object.keys(exp).join(', '));
['sales', 'items', 'partners', 'users', 'partnerInfo', 'itemInfo', 'partnerProps'].forEach(k => {
  const a = exp[k]; if(Array.isArray(a) && a.length) console.log('  ' + k + ': ' + a.length + ' · поля: ' + Object.keys(a[0]).join(', '));
});
const dts = (exp.sales || []).map(s => String(s.dt).slice(0, 10)).sort();
console.log('  продажи с ' + dts[0] + ' по ' + dts[dts.length - 1] + '; periodFrom/To: ' + exp.periodFrom + ' / ' + exp.periodTo);
const ex = (exp.sales || [])[0]; console.log('  пример продажи (без id): ' + JSON.stringify(Object.fromEntries(Object.entries(ex || {}).map(([k, v]) => [k, /^[0-9a-f-]{36}$/.test(String(v)) ? 'uuid' : v]))));

const items = new Map(exp.items.map(i => [i.id, i]));
const chain = id => { const out = []; let x = items.get(id); for(let i = 0; x && i < 10; i++){ out.unshift(x.name); x = items.get(x.parent); } return out.join(' / '); };
const gb = exp.items.filter(i => /грин|green|бим|beam/i.test(i.name));
console.log('\n== товары «грин/green/бим/beam»: ' + gb.length);
const salesBy = new Map();
(exp.sales || []).forEach(s => { if(!salesBy.has(s.item)) salesBy.set(s.item, []); salesBy.get(s.item).push(s); });
gb.forEach(i => {
  const ss = salesBy.get(i.id) || [];
  const d = ss.map(s => String(s.dt).slice(0, 10)).sort();
  console.log('  ' + (i.isGroup ? '[группа] ' : '') + (i.deleted ? '[удалён] ' : '') + chain(i.id) + ' · продаж ' + ss.length + ' · точек ' + new Set(ss.map(s => s.partner)).size + (d.length ? ' · первая ' + d[0] + ' последняя ' + d[d.length - 1] : '') + ' · поля: ' + JSON.stringify(Object.fromEntries(Object.entries(i).filter(([k]) => !/^(id|parent|name)$/.test(k)))));
});

// тип клиента: распределение по родителю значения
const ctx = (function(){ try{ return rules1c.build(exp, cfg).ctx; }catch(e){ console.log('rules1c.build: ' + e.message); return null; } })();
if(ctx){
  const tp = ctx.propIds('Тип клиента');
  const cnt = {};
  exp.partners.forEach(p => { if(p.isGroup) return; const r = ctx.propRow(ctx.pProps, p.id, tp); const v = r && ctx.vals.get(r.val); const par = v && ctx.vals.get(v.parent); const k = (par ? par.name + ' → ' : '') + (v ? v.name : '(нет)'); cnt[k] = (cnt[k] || 0) + 1; });
  console.log('\n== Тип клиента у точек:'); Object.entries(cnt).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
  const st = {}; exp.partners.forEach(p => { if(p.isGroup) return; const k = p.pointStatusText || '(нет)'; st[k] = (st[k] || 0) + 1; });
  console.log('  Статус точки: ' + JSON.stringify(st));
  const mg = {}; const users = new Map(exp.users.map(u => [u.id, u.name])); exp.partners.forEach(p => { if(p.isGroup) return; const m = p.managerText || users.get(p.manager) || '(нет)'; const k = cfg.managers.some(x => x.name === m) ? m : (m === '(нет)' ? m : 'другой'); mg[k] = (mg[k] || 0) + 1; });
  console.log('  Основной менеджер: ' + JSON.stringify(mg));
}

// рассылка 123
const mailings = JSON.parse(exp.mailingsJson);
const m = mailings.find(x => x.name.trim() === '123');
console.log('\n== рассылка 123, таблицы: ' + Object.keys(m.tables || {}).join(', '));
const resolve = v => { const s = String(v); if(items.has(s)) return 'Номенклатура:' + items.get(s).name; if(ctx && ctx.vals.has(s)) return 'Значение:' + ctx.vals.get(s).name; const p = exp.partners.find(x => x.id === s); if(p) return p.isGroup ? 'ГруппаПартнеров:' + p.name : '<ТОЧКА>'; const u = exp.users.find(x => x.id === s); if(u) return '<ЧЕЛ>' + (cfg.managers.some(x => x.name === u.name) ? '(' + u.name + ')' : ''); const pr = (exp.properties || []).find(x => x.id === s); if(pr) return 'Реквизит:' + pr.name; return s; };
Object.keys(m.tables || {}).forEach(t => (m.tables[t] || []).forEach((row, i) => {
  const refs = []; (function walk(n){ if(!n || typeof n !== 'object') return; if(Array.isArray(n)) return n.forEach(walk); if(n.$ref){ refs.push(n.$ref + ' = ' + n.text); if(n.attrs) walk(n.attrs); return; } Object.values(n).forEach(walk); })(row);
  console.log('  [' + t + ' #' + i + '] ' + refs.slice(0, 6).join(' | '));
  const names = refs.join(' ');
  if(!/плоск/i.test(names)) return;
  const sets = []; (function walk(n, inRef){ if(!n || typeof n !== 'object') return; if(Array.isArray(n)) return n.forEach(x => walk(x, inRef)); if(n.$dcs){ sets.push({ kind: n.$dcs, xml: n.xml, inRef }); return; } if(n.$ref){ if(n.attrs) walk(n.attrs, true); return; } Object.values(n).forEach(x => walk(x, inRef)); })(row, false);
  console.log('    настройки: ' + sets.map(s => s.kind + (s.inRef ? '(вариант)' : '(рассылка)') + ' ' + String(s.xml).length + ' симв.').join(', '));
  const full = sets.find(s => !s.inRef && s.kind === 'Settings') || sets.find(s => s.kind === 'Settings' && s.inRef);
  const user = sets.filter(s => !s.inRef && s.kind === 'UserSettings').map(s => s.xml);
  if(!full){ console.log('    нет Settings'); return; }
  const r = dcs.readSettings(full.xml, user);
  console.log('    отборы:'); r.filters.forEach(f => console.log('      ' + f.field + ' ' + f.cmp + ' ' + f.values.map(v => v.type + ':' + resolve(v.v && v.v.variant ? JSON.stringify(v.v) : v.v)).join(', ')));
  console.log('    параметры: ' + JSON.stringify(r.params));
  console.log('    группировки: ' + r.groupFields.join(', '));
  console.log('    польз. поля: ' + r.userFields.map(u => u.title + ' = ' + u.expr.slice(0, 200)).join(' || '));
  const sel = Array.from(new Set((String(full.xml).match(/<(?:\w+:)?field>([^<]+)<\/(?:\w+:)?field>/g) || []).map(x => x.replace(/<[^>]+>/g, ''))));
  console.log('    все поля в XML: ' + sel.join(', '));
  console.log('    applied user settings: ' + r.appliedUserSettings);
}));

// продажи по месяцам: сколько точек с продажами (АКБ) у каждого менеджера сайта
const users = new Map(exp.users.map(u => [u.id, u.name]));
const P = new Map(exp.partners.map(p => [p.id, p]));
const akb = {};
(exp.sales || []).forEach(s => { if(!(Number(s.qty) > 0)) return; const p = P.get(s.partner); if(!p) return; const mn = p.managerText || users.get(p.manager) || '(нет)'; const k = (cfg.managers.some(x => x.name === mn) ? mn : 'другие') + ' ' + String(s.dt).slice(0, 7); (akb[k] = akb[k] || new Set()).add(s.partner); });
console.log('\n== точек с продажами по месяцам: ' + Object.keys(akb).sort().map(k => k + '=' + akb[k].size).join('; '));
