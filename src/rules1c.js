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

// строки (отчёты) рассылки из выгрузки; rowInfo вызывается лениво — ошибка настроек
// одного отчёта не мешает читать остальные
function mailingRows(exp, cfg){
  if(!exp.mailingsJson) throw new Error('в выгрузке 1С нет настроек рассылок (mailingsJson) — обновите расширение pe_Portal');
  let mailings;
  try{ mailings = JSON.parse(exp.mailingsJson); }
  catch(e){ throw new Error('не удалось прочитать настройки рассылок из выгрузки: ' + e.message); }
  const want = String((cfg.export && cfg.export.mailing) || '123');
  const m = mailings.find(x => norm(x.name) === norm(want));
  if(!m) throw new Error('в 1С не найдена рассылка «' + want + '» (есть: ' + mailings.map(x => x.name).join(', ') + ')');
  const rows = [];
  Object.keys(m.tables || {}).forEach(t => (m.tables[t] || []).forEach(r => rows.push(r)));
  return rows;
}

module.exports = { mailingRows, rowInfo };
