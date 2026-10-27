// Правила расчёта отчётов — из настроек отчётов рассылки 1С (по умолчанию «123»).
// Расширение pe_Portal кладёт в выгрузку (поле mailingsJson) все рассылки с их строками:
// вариант отчёта (с его настройками СКД) и настройки, сохранённые в самой рассылке.
// Здесь из них получаются отборы, периоды, позиции ММЛ, исключённые менеджеры и реквизит плана.
'use strict';

const dcs = require('./dcs');

function norm(s){ return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }

// ---------- поиск настроек в строке рассылки ----------
function collect(node, inRef, out){
  if(!node || typeof node !== 'object') return out;
  if(Array.isArray(node)){ node.forEach(n => collect(n, inRef, out)); return out; }
  if(node.$dcs){ out.push({ kind: node.$dcs, xml: node.xml, inRef }); return out; }
  if(node.$ref){
    out.refs.push(node);
    if(node.attrs) collect(node.attrs, true, out);
    return out;
  }
  Object.keys(node).forEach(k => collect(node[k], inRef, out));
  return out;
}

function rowInfo(row){
  const found = collect(row, false, Object.assign([], { refs: [] }));
  const variant = found.refs.find(r => /ВариантыОтчетов|ReportsOptions/i.test(r.$ref)) || null;
  const names = [];
  if(variant) names.push(variant.text, (variant.attrs || {}).Наименование);
  found.refs.forEach(r => names.push(r.text));
  const bad = found.filter(f => /^ERROR/.test(String(f.xml)));
  if(bad.length) throw new Error('1С не смогла сохранить настройки отчёта «' + (variant ? variant.text : '?') + '»: ' + bad[0].xml);
  return {
    name: (variant && variant.text) || names.filter(Boolean)[0] || '',
    names: names.filter(Boolean),
    base: found.filter(f => f.kind === 'Settings' && f.inRef),
    own: found.filter(f => !f.inRef)
  };
}

function reportSettings(exp, cfg){
  if(!exp.mailingsJson) throw new Error('в выгрузке 1С нет настроек рассылок (mailingsJson) — обновите расширение pe_Portal');
  let mailings;
  try{ mailings = JSON.parse(exp.mailingsJson); }
  catch(e){ throw new Error('не удалось прочитать настройки рассылок из выгрузки: ' + e.message); }
  const want = String((cfg.export && cfg.export.mailing) || '123');
  const m = mailings.find(x => norm(x.name) === norm(want));
  if(!m) throw new Error('в 1С не найдена рассылка «' + want + '» (есть: ' + mailings.map(x => x.name).join(', ') + ')');
  const rows = [];
  Object.keys(m.tables || {}).forEach(t => (m.tables[t] || []).forEach(r => {
    const info = rowInfo(r);
    if(info.base.length || info.own.some(o => o.kind === 'Settings')) rows.push(info);
  }));
  const out = {};
  cfg.files.forEach(d => {
    const hits = rows.filter(r => r.names.some(n => d.match.every(w => norm(n).indexOf(norm(w)) >= 0)));
    if(!hits.length) throw new Error('в рассылке «' + want + '» нет отчёта для «' + d.key + '» (ищу в названии: ' + d.match.join(' + ') + '). Отчёты рассылки: ' + rows.map(r => '«' + r.name + '»').join(', '));
    if(hits.length > 1) throw new Error('в рассылке «' + want + '» под «' + d.key + '» подходят несколько отчётов: ' + hits.map(r => '«' + r.name + '»').join(', '));
    const r = hits[0];
    const fullOwn = r.own.find(o => o.kind === 'Settings');
    const base = fullOwn ? fullOwn.xml : r.base[0].xml;
    const user = r.own.filter(o => o.kind === 'UserSettings').map(o => o.xml);
    out[d.key] = Object.assign(dcs.readSettings(base, user), { reportName: r.name });
  });
  return out;
}

// ---------- период ----------
function pad(n){ return String(n).padStart(2, '0'); }
function ymd(d){ return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function period(p, today){
  if(!p || p.type !== 'period') throw new Error('не задан период');
  const v = p.v.variant;
  const t = new Date(today + 'T00:00:00Z');
  const Y = t.getUTCFullYear(), M = t.getUTCMonth();
  const U = (y, m, d) => new Date(Date.UTC(y, m, d));
  const q = Math.floor(M / 3) * 3;
  switch(v){
    case 'Custom': return { from: String(p.v.start).slice(0, 10), to: String(p.v.end).slice(0, 10) };
    case 'Today': return { from: today, to: today };
    case 'ThisMonth': return { from: ymd(U(Y, M, 1)), to: ymd(U(Y, M + 1, 0)) };
    case 'LastMonth': return { from: ymd(U(Y, M - 1, 1)), to: ymd(U(Y, M, 0)) };
    case 'ThisQuarter': return { from: ymd(U(Y, q, 1)), to: ymd(U(Y, q + 3, 0)) };
    case 'LastQuarter': return { from: ymd(U(Y, q - 3, 1)), to: ymd(U(Y, q, 0)) };
    case 'ThisHalfYear': { const h = M < 6 ? 0 : 6; return { from: ymd(U(Y, h, 1)), to: ymd(U(Y, h + 6, 0)) }; }
    case 'ThisYear': return { from: Y + '-01-01', to: Y + '-12-31' };
    case 'FromBeginningOfThisMonth': return { from: ymd(U(Y, M, 1)), to: today };
    case 'FromBeginningOfThisQuarter': return { from: ymd(U(Y, q, 1)), to: today };
    case 'FromBeginningOfThisYear': return { from: Y + '-01-01', to: today };
    default: throw new Error('вариант периода «' + v + '» пока не поддерживается');
  }
}

// ---------- отборы ----------
// Поле СКД «Номенклатура.[ММЛ Задача 10.26 - 12.26 (Общие)]» → имя доп. реквизита без набора.
function propName(bracket){ return bracket.replace(/\s*\([^()]*\)\s*$/, '').trim(); }

function makeContext(exp){
  const props = exp.properties || [];
  const vals = new Map();
  (exp.propertyValues || []).concat(exp.propertyValuesHier || []).forEach(v => vals.set(v.id, v));
  const items = new Map(exp.items.map(i => [i.id, i]));
  const partners = new Map(exp.partners.map(p => [p.id, p]));
  function objProps(rows){
    const m = new Map();
    (rows || []).forEach(r => {
      if(!r.prop) return;
      if(!m.has(r.obj)) m.set(r.obj, new Map());
      m.get(r.obj).set(r.prop, r);
    });
    return m;
  }
  const pProps = objProps((exp.partnerProps || []).concat(exp.partnerInfo || []));
  const iProps = objProps((exp.itemProps || []).concat(exp.itemInfo || []));
  function propIds(bracket){
    const full = norm(bracket), short = norm(propName(bracket));
    const ids = props.filter(p => !p.deleted && (norm(p.name) === short || norm(p.name) === full)).map(p => p.id);
    if(!ids.length) throw new Error('в 1С нет доп. реквизита «' + propName(bracket) + '»');
    return ids;
  }
  function propRow(map, obj, ids){ const o = map.get(obj); if(!o) return null; for(const id of ids){ const r = o.get(id); if(r) return r; } return null; }
  function inValueTree(vid, root){ for(let i = 0; vid && i < 30; i++){ if(vid === root) return true; vid = (vals.get(vid) || {}).parent; } return false; }
  function inItemTree(iid, root){ for(let i = 0; iid && i < 40; i++){ if(iid === root) return true; iid = (items.get(iid) || {}).parent; } return false; }
  function inPartnerTree(pid, root){ for(let i = 0; pid && i < 40; i++){ if(pid === root) return true; pid = (partners.get(pid) || {}).parent; } return false; }
  return { vals, items, partners, pProps, iProps, propIds, propRow, inValueTree, inItemTree, inPartnerTree };
}

const EMPTY = '00000000-0000-0000-0000-000000000000';
function isEmpty(v){ return v === null || v === undefined || v === '' || v === EMPTY || v === 0 || v === false; }

// сравнение одного значения с правой частью отбора
function compare(cmp, actual, values, inTree){
  const vs = values.map(x => x.v);
  const eq = x => vs.some(v => String(v) === String(x));
  const tree = x => vs.some(v => inTree(x, v));
  switch(cmp){
    case 'Equal': return eq(actual);
    case 'NotEqual': return !eq(actual);
    case 'InList': return eq(actual);
    case 'NotInList': return !eq(actual);
    case 'InHierarchy': case 'InListByHierarchy': return !isEmpty(actual) && tree(actual);
    case 'NotInHierarchy': case 'NotInListByHierarchy': return isEmpty(actual) || !tree(actual);
    case 'Filled': return !isEmpty(actual);
    case 'NotFilled': return isEmpty(actual);
    case 'Greater': return Number(actual) > Number(vs[0]);
    case 'GreaterOrEqual': return Number(actual) >= Number(vs[0]);
    case 'Less': return Number(actual) < Number(vs[0]);
    case 'LessOrEqual': return Number(actual) <= Number(vs[0]);
    default: return null;
  }
}

function compileFilters(filters, ctx, reportName){
  const item = [], partner = [], manager = [];
  const describe = f => '«' + f.field + ' ' + f.cmp + '»';
  filters.forEach(f => {
    if(f.unsupported) throw new Error('в отчёте «' + reportName + '» отбор-группа ' + f.cmp + ' (ИЛИ/НЕ) пока не поддерживается сайтом');
    const fld = f.field.replace(/\s+/g, ' ').trim();
    let m;
    const test = (actual, inTree) => {
      const r = compare(f.cmp, actual, f.values, inTree || (() => false));
      if(r === null) throw new Error('в отчёте «' + reportName + '» вид сравнения ' + describe(f) + ' пока не поддерживается сайтом');
      return r;
    };
    test(null); // проверка, что вид сравнения поддерживается
    if(fld === 'Номенклатура'){
      item.push(iid => test(iid, ctx.inItemTree));
    } else if((m = /^Номенклатура\.\[(.+)\]$/.exec(fld))){
      const ids = ctx.propIds(m[1]);
      item.push(iid => { const r = ctx.propRow(ctx.iProps, iid, ids); return test(r ? r.val : null, ctx.inValueTree); });
    } else if(fld === 'Номенклатура.Родитель'){
      item.push(iid => test((ctx.items.get(iid) || {}).parent || null, ctx.inItemTree));
    } else if(fld === 'Партнер'){
      partner.push(pid => test(pid, ctx.inPartnerTree));
    } else if((m = /^Партнер\.\[(.+)\]$/.exec(fld))){
      const ids = ctx.propIds(m[1]);
      partner.push(pid => { const r = ctx.propRow(ctx.pProps, pid, ids); return test(r ? r.val : null, ctx.inValueTree); });
    } else if(/^(Партнер\.)?ОсновнойМенеджер$/.test(fld)){
      manager.push(mid => test(mid || null));
    } else if(fld === 'Партнер.СтатусТочки'){
      partner.push(pid => test((ctx.partners.get(pid) || {}).pointStatus || null));
    } else {
      throw new Error('в отчёте «' + reportName + '» отбор по полю «' + f.field + '» пока не поддерживается сайтом');
    }
  });
  const all = list => x => list.every(fn => fn(x));
  return { item: all(item), partner: all(partner), manager: all(manager), count: filters.length };
}

// ---------- сборка правил ----------
function build(exp, cfg){
  const today = String(exp.periodTo || exp.createdAt).slice(0, 10);
  const rs = reportSettings(exp, cfg);
  const ctx = makeContext(exp);
  const spec = {};
  const findProp = (s, re) => {
    const all = s.groupFields.concat(s.filters.map(f => f.field));
    for(const f of all){ const m = re.exec(f); if(m) return m[1]; }
    return null;
  };
  cfg.files.forEach(d => {
    const s = rs[d.key];
    const name = s.reportName;
    const flt = compileFilters(s.filters, ctx, name);
    const r = { key: d.key, kind: d.kind, reportName: name, filters: flt, raw: s };
    const ct = findProp(s, /^Партнер\.\[(Тип клиента[^\]]*)\]/);
    r.typeProp = ct ? ctx.propIds(ct) : ctx.propIds('Тип клиента');
    if(d.kind === 'channel'){
      Object.assign(r, period(s.params['СтандартныйПериод'] || s.params['Период'], today));
      const uf = s.groupFields.filter(g => /^ПользовательскиеПоля\./.test(g))
        .map(g => s.userFields.find(u => u.path === g)).filter(Boolean)
        .map(u => ({ u, c: dcs.parseChoice(u.expr) })).find(x => x.c && x.c.map.size);
      if(!uf) throw new Error('в отчёте «' + name + '» не найдено пользовательское поле «Выбор … Когда Номенклатура.Наименование = …» в группировках — не из чего взять позиции ММЛ');
      if(uf.c.unparsed.length) throw new Error('в отчёте «' + name + '», поле «' + uf.u.title + '»: не понял условие «' + uf.c.unparsed[0] + '». Поддерживается «Номенклатура.Наименование = "…"» (через «Или») и «Номенклатура.Наименование В (…)»');
      r.choice = uf.c.map;
      r.choiceTitle = uf.u.title;
      const st = findProp(s, /^Партнер\.\[(Статус клиента[^\]]*)\]/);
      r.statusProp = st ? ctx.propIds(st) : [];
    } else if(d.kind === 'dark'){
      Object.assign(r, period(s.params['СтандартныйПериод'] || s.params['Период'], today));
      const planUf = s.userFields.find(u => /^план/i.test(u.title));
      let pn = null;
      if(planUf){ const m = /Партнер\.\[([^\]]+)\]/.exec(planUf.expr); if(m) pn = m[1]; }
      if(!pn) pn = findProp(s, /^Партнер\.\[(ТС [^\]]+)\]/);
      r.planPropertyName = pn ? propName(pn) : null;
      try{ r.planProp = pn ? ctx.propIds(pn) : []; } catch(e){ r.planProp = []; }
    } else {
      const step = s.params['ШагПериодовСравнения'];
      if(step && norm(step.v) !== 'месяц') throw new Error('в отчёте «' + name + '» шаг периодов «' + step.v + '», сайт умеет только «Месяц»');
      const p = period(s.params['ПериодОтчета'] || s.params['СтандартныйПериод'], today);
      r.lastMonth = p.to.slice(0, 7);
      r.months = Number((s.params['КоличествоПериодов'] || {}).v) || 1;
      r.withQty = d.kind === 'acc';
    }
    spec[d.key] = r;
  });
  return { spec, ctx };
}

module.exports = { build, reportSettings, period, propName };
