// Разбор настроек отчётов 1С (схема компоновки данных, СКД), выгруженных расширением pe_Portal.
// Настройки варианта отчёта и настройки, сохранённые в рассылке, сериализованы платформой в XML
// (XDTOSerializer). Здесь они склеиваются (пользовательские настройки рассылки поверх варианта —
// по userSettingID, как это делает сама 1С) и превращаются в простую структуру:
//   { filters: [...], params: {...}, userFields: [...], groupFields: [...] }
'use strict';

const { DOMParser } = require('@xmldom/xmldom');

function parseXml(xml){
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning(){}, error(e){ errors.push(e); }, fatalError(e){ errors.push(e); } } })
    .parseFromString(String(xml).replace(/^﻿/, ''), 'text/xml');
  if(errors.length || !doc.documentElement) throw new Error('не удалось разобрать XML настроек: ' + (errors[0] || 'пустой документ'));
  return doc;
}

const kids = (el, name) => {
  const out = [];
  for(let n = el && el.firstChild; n; n = n.nextSibling) if(n.nodeType === 1 && (!name || n.localName === name)) out.push(n);
  return out;
};
const kid = (el, name) => kids(el, name)[0] || null;
const text = el => el ? String(el.textContent || '') : '';
const xsiType = el => {
  if(!el) return '';
  const t = el.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type') || el.getAttribute('xsi:type') || '';
  return t.replace(/^.*:/, '');
};
const fullType = el => el ? (el.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type') || el.getAttribute('xsi:type') || '') : '';
const isOff = el => text(kid(el, 'use')).trim() === 'false';

// все элементы (на любой глубине) с дочерним <userSettingID>
function withUserIds(root){
  const out = new Map();
  (function walk(el){
    for(const c of kids(el)){
      const id = kid(c, 'userSettingID');
      if(id && text(id).trim()) out.set(text(id).trim(), c);
      walk(c);
    }
  })(root);
  return out;
}

// пользовательские настройки (из рассылки) поверх настроек варианта
function merge(settingsXml, userXmls){
  const doc = parseXml(settingsXml);
  const root = doc.documentElement;
  const applied = [];
  (userXmls || []).forEach(ux => {
    if(!ux) return;
    const udoc = parseXml(ux);
    const target = withUserIds(root);
    withUserIds(udoc.documentElement).forEach((uel, id) => {
      const vel = target.get(id);
      if(!vel) return;
      // В пользовательской настройке нет поля (<left>) и прочего «описания» элемента —
      // только то, что пользователь может менять: use, вид сравнения, значения. Их и заменяем.
      // Отсутствие <use> означает «включено», поэтому <use> варианта удаляется всегда.
      const replace = new Set(['use', 'right', 'value']);
      kids(uel).forEach(c => { if(c.localName !== 'userSettingID') replace.add(c.localName); });
      kids(vel).forEach(c => { if(replace.has(c.localName)) vel.removeChild(c); });
      const idEl = kid(vel, 'userSettingID');
      kids(uel).forEach(c => { if(c.localName !== 'userSettingID') vel.insertBefore(doc.importNode(c, true), idEl); });
      applied.push(id);
    });
  });
  return { root, applied };
}

function value(el){
  const t = fullType(el);
  const local = t.replace(/^.*:/, '');
  const raw = text(el).trim();
  if(el.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') === 'true') return { type: 'null', v: null };
  if(/^(CatalogRef|ChartOfCharacteristicTypesRef|DocumentRef|EnumRef)\./.test(local)) return { type: local, v: raw };
  if(local === 'decimal') return { type: 'number', v: Number(raw) };
  if(local === 'boolean') return { type: 'boolean', v: raw === 'true' };
  if(local === 'dateTime') return { type: 'date', v: raw };
  if(local === 'StandardPeriod'){
    return { type: 'period', v: { variant: text(kid(el, 'variant')).trim(), start: text(kid(el, 'startDate')).trim() || null, end: text(kid(el, 'endDate')).trim() || null } };
  }
  return { type: local || 'string', v: raw };
}

// отборы: только включённые элементы; группы «И» раскрываются, «ИЛИ»/«НЕ» отмечаются отдельно
function readFilter(filterEl, out){
  for(const it of kids(filterEl, 'item')){
    if(isOff(it)) continue;
    const t = xsiType(it);
    if(t === 'FilterItemComparison'){
      out.push({
        field: text(kid(it, 'left')).trim(),
        cmp: text(kid(it, 'comparisonType')).trim(),
        values: kids(it, 'right').map(value),
        presentation: text(kid(it, 'presentation')).trim() || null
      });
    } else if(t === 'FilterItemGroup'){
      const gt = text(kid(it, 'groupType')).trim();
      if(gt === 'AndGroup' || gt === '') readFilter(it, out);
      else out.push({ field: '(группа ' + gt + ')', cmp: gt, values: [], unsupported: true });
    }
  }
  return out;
}

function readParams(el){
  const out = {};
  for(const it of kids(el, 'item')){
    if(isOff(it)) continue;
    const name = text(kid(it, 'parameter')).trim();
    const v = kid(it, 'value');
    if(name && v && !(name in out)) out[name] = value(v);
  }
  return out;
}

function readUserFields(el){
  return kids(el, 'item').map(it => ({
    path: text(kid(it, 'dataPath')).trim(),
    title: text(kid(it, 'title')).trim(),
    type: xsiType(it),
    expr: text(kid(it, 'detailExpression')),
    exprPresentation: text(kid(it, 'detailExpressionPresentation'))
  }));
}

// поля группировок включённых элементов структуры (на любой глубине)
function readGroupFields(root){
  const out = [];
  (function walk(el){
    for(const c of kids(el)){
      if(isOff(c)) continue;
      const ln = c.localName;
      if(ln === 'groupItems'){
        for(const gi of kids(c, 'item')) if(!isOff(gi) && xsiType(gi) === 'GroupItemField') out.push(text(kid(gi, 'field')).trim());
        continue;
      }
      if(ln === 'filter' || ln === 'conditionalAppearance' || ln === 'outputParameters' || ln === 'userFields' || ln === 'dataParameters' || ln === 'order') continue;
      walk(c);
    }
  })(root);
  return out;
}

function readSettings(settingsXml, userXmls){
  const { root, applied } = merge(settingsXml, userXmls);
  return {
    filters: readFilter(kid(root, 'filter'), []),
    params: readParams(kid(root, 'dataParameters')),
    userFields: readUserFields(kid(root, 'userFields')),
    groupFields: readGroupFields(root),
    appliedUserSettings: applied.length
  };
}

// ---------- выражения пользовательских полей ----------
// «Выбор Когда Номенклатура.Наименование = "…" Или … Тогда "Позиция" … Иначе "" Конец»
// → Map(наименование товара → позиция). Непонятные условия возвращаются в unparsed.
function parseChoice(expr){
  const s = String(expr || '');
  if(!/^\s*(выбор|case)(?![а-яёa-z0-9_])/i.test(s)) return null;
  const strRe = '"((?:[^"]|"")*)"';
  const branches = [];
  const re = new RegExp('(?:Когда|When)([\\s\\S]*?)(?:Тогда|Then)\\s*' + strRe, 'gi');
  let m;
  while((m = re.exec(s))) branches.push({ cond: m[1], result: m[2].replace(/""/g, '"') });
  const map = new Map();
  const unparsed = [];
  branches.forEach(b => {
    let cond = b.cond.replace(/[\[\]]/g, '');
    const nameField = '(?:Номенклатура|Nomenclature)\\.(?:Наименование|Description)';
    const eq = new RegExp(nameField + '\\s*=\\s*' + strRe, 'gi');
    const inl = new RegExp(nameField + '\\s+(?:В|IN)\\s*\\(([^)]*)\\)', 'gi');
    let k, any = false;
    while((k = eq.exec(cond))){ const n = k[1].replace(/""/g, '"'); if(!map.has(n)) map.set(n, b.result); any = true; } // как в 1С: срабатывает первая ветка
    while((k = inl.exec(cond))){
      const ss = new RegExp(strRe, 'g'); let q;
      while((q = ss.exec(k[1]))){ const n = q[1].replace(/""/g, '"'); if(!map.has(n)) map.set(n, b.result); any = true; }
    }
    const rest = cond.replace(eq, '').replace(inl, '').replace(/(^|[^а-яёa-z0-9_])(Или|Or)(?![а-яёa-z0-9_])/gi, '$1').trim();
    if(!any || rest) unparsed.push(b.cond.trim().slice(0, 200));
  });
  return { map, unparsed, branches: branches.length };
}

module.exports = { readSettings, parseChoice, parseXml };
