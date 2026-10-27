// Советы для менеджеров. Вызывается ТОЛЬКО из build.js с флагом --tips (см. update.yml).
// Ручная сборка (manual.js) флаг не передаёт — модели не вызываются.
//
// Как устроено:
//  1. reasons.js находит поводы (кто, что, сколько) — все цифры считает код.
//  2. Здесь выбираются 6 поводов на менеджера: разные типы, не больше одного на точку,
//     без повторов того, что уже советовали в последние дни (журнал).
//  3. Модель только пишет текст по поводам: Claude (токен подписки, CLAUDE_CODE_OAUTH_TOKEN) →
//     Gemini (GEMINI_API_KEY) → готовый текст из кода. Советы есть всегда.
//  4. Советы готовятся один раз в день; остальные сборки дня берут их из журнала.
//
// Журнал хранится зашифрованным (TIPS_STATE_KEY) в файле, который workflow скачивает из релиза
// data-export и загружает обратно. Репозиторий публичный: в логи Actions не пишем названий точек.
//
// Любая ошибка здесь не ломает сборку: страница соберётся без советов или с прежними.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const reasons = require('./reasons');

const TIPS_PER_MANAGER = 6;
const KEY_COOLDOWN_DAYS = 10;    // тот же повод по той же точке — не чаще раза в 10 дней
const MIN_KEY_COOLDOWN_DAYS = 5; // …но если новых поводов не хватает — можно повторить через 5 дней
const POINT_COOLDOWN_DAYS = 4;   // одна точка (любой повод) — не чаще раза в 4 дня
const HISTORY_DAYS = 45;
const CLAUDE_MODEL = 'sonnet';
const CLAUDE_TIMEOUT_MS = 240000;
const GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_FALLBACK = 'gemini-flash-lite-latest';
const GEMINI_RETRY_MS = [4000, 12000];
const GEMINI_TIMEOUT_MS = 60000;

// Порядок типов поводов. Каждый день сдвигается, чтобы первым шёл разный тип.
const TYPES = ['overdue', 'dark_near', 'dropped', 'mml', 'lost', 'trend', 'esdn', 'acc', 'dark_zero', 'plan'];
const MAX_PER_TYPE = { plan: 1 };

// ---------- дата ----------
function calendar(){
  const now = process.env.TIPS_DATE ? new Date(process.env.TIPS_DATE + 'T08:00:00Z') : new Date(); // TIPS_DATE — только для проверок
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Samara', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-');
  const y = +parts[0], m = +parts[1], d = +parts[2];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let left = 0;
  for(let day = d; day <= last; day++){ const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay(); if(wd !== 0 && wd !== 6) left++; }
  const iso = parts.join('-');
  return { iso: iso, ru: parts[2] + '.' + parts[1] + '.' + parts[0], dayIndex: Math.floor(Date.UTC(y, m - 1, d) / 86400000), workdaysLeft: Math.max(left, 1) };
}
function daysBetween(a, b){ return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

// ---------- журнал (зашифрованный JSON) ----------
function keyFrom(secret, salt){ return crypto.scryptSync(String(secret), salt, 32); }
function loadState(file, secret){
  const empty = { history: [], daily: null };
  if(!file || !secret || !fs.existsSync(file)) return empty;
  try{
    const box = JSON.parse(fs.readFileSync(file, 'utf8'));
    const salt = Buffer.from(box.salt, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret, salt), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    const st = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
    return { history: st.history || [], daily: st.daily || null };
  }catch(e){
    console.warn('  ⚠ Журнал советов не прочитан (' + e.message + ') — начинаю новый.');
    return empty;
  }
}
function saveState(file, secret, st){
  if(!file || !secret) return;
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(st), 'utf8'), c.final()]);
  fs.writeFileSync(file, JSON.stringify({ v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }));
}

// ---------- отбор поводов ----------
function select(list, history, mgr, cal){
  const keyAge = new Map(), recentPoints = new Set();
  history.forEach(function(h){
    if(h.mgr !== mgr) return;
    const age = daysBetween(h.date, cal.iso);
    if(age < 1) return; // сегодняшние записи — это пересборка того же дня
    if(!keyAge.has(h.key) || keyAge.get(h.key) > age) keyAge.set(h.key, age);
    if(h.point && age < POINT_COOLDOWN_DAYS) recentPoints.add(h.point);
  });
  let keyCooldown = KEY_COOLDOWN_DAYS;
  // в конце месяца «Тёмные силы» срочнее: близкие к порогу точки можно повторять через 3 дня и ставить первыми
  const endOfMonth = cal.workdaysLeft <= 5;
  const cooled = function(r){
    if(r.type === 'dark_near' && endOfMonth){
      return history.some(function(h){ return h.mgr === mgr && h.key === r.key && daysBetween(h.date, cal.iso) >= 1 && daysBetween(h.date, cal.iso) < 3; });
    }
    return keyAge.has(r.key) && keyAge.get(r.key) < keyCooldown;
  };
  let order = TYPES.slice(); const shift = cal.dayIndex % order.length;
  order = order.slice(shift).concat(order.slice(0, shift));
  if(endOfMonth) order = ['dark_near'].concat(order.filter(function(t){ return t !== 'dark_near'; }));

  let byType = {};
  const fill = function(){
    const taken = new Set(picked);
    byType = {};
    list.filter(function(r){ return !taken.has(r) && !cooled(r); }).forEach(function(r){ (byType[r.type] = byType[r.type] || []).push(r); });
    Object.keys(byType).forEach(function(t){ byType[t].sort(function(a, b){ return b.value - a.value; }); });
  };
  const picked = [], usedPoints = new Set(), perType = {};
  fill();
  function pass(skipRecentPoints, cap){
    let progress = true;
    while(picked.length < TIPS_PER_MANAGER && progress){
      progress = false;
      for(const t of order){
        if(picked.length >= TIPS_PER_MANAGER) break;
        if((perType[t] || 0) >= Math.min(cap, MAX_PER_TYPE[t] || cap)) continue;
        const q = byType[t] || [];
        const i = q.findIndex(function(r){ return !(r.point && (usedPoints.has(r.point) || (skipRecentPoints && recentPoints.has(r.point)))); });
        if(i < 0) continue;
        const r = q.splice(i, 1)[0];
        picked.push(r); perType[t] = (perType[t] || 0) + 1;
        if(r.point) usedPoints.add(r.point);
        progress = true;
      }
    }
  }
  pass(true, 2);   // разные типы, точки, о которых не говорили последние дни
  pass(false, 2);  // если не хватило — можно точки из недавних (но не тот же повод)
  pass(false, 3);
  if(picked.length < TIPS_PER_MANAGER){ keyCooldown = MIN_KEY_COOLDOWN_DAYS; fill(); pass(false, 3); } // мало новых поводов — можно вернуться к давним
  return picked;
}

// ---------- текст: модель ----------
const SYSTEM =
  'Ты — опытный руководитель отдела продаж дистрибьютора табачной продукции и кальянных аксессуаров. ' +
  'Каждое утро ты превращаешь найденные системой поводы в короткие советы менеджерам по продажам.\n\n' +
  'ПРАВИЛА:\n' +
  '1. Один совет на каждый повод, с тем же id. Не пропускай поводы и не добавляй свои.\n' +
  '2. Используй только факты повода. Названия точек и позиций — дословно, цифры — как даны (их уже посчитали). Не придумывай причин, остатков, конкурентов, договорённостей.\n' +
  '3. Совет = конкретное действие (позвонить, заехать, предложить определённые позиции, договориться о заказе, выяснить причину) + почему сейчас (факт из повода) + что это даст для показателя.\n' +
  '4. Пиши живо и по-разному: не начинай советы одинаково, не повторяй одни и те же обороты. Деловой тон, на «вы», без лозунгов и воды.\n' +
  '5. «Тёмные силы» засчитываются, когда точка выполнила свой план на 90% и выше. ЭСДН продаётся только в рознице.\n' +
  '6. Если в поводе нет точки (план менеджера) — дай план действий на оставшиеся дни, опираясь на цифры повода.\n' +
  '7. title — суть до 7 слов, без названия показателя. text — не больше 3 предложений и 330 знаков: менеджер читает с телефона.\n\n' +
  'Ответь ТОЛЬКО JSON без пояснений: {"tips":[{"id":"…","title":"…","text":"…"}]}';

// формат ответа: Claude Code проверяет его сам (--json-schema), так что сломанный JSON не придёт
const SCHEMA = { type: 'object', required: ['tips'], properties: { tips: { type: 'array', items: { type: 'object', required: ['id', 'title', 'text'],
  properties: { id: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } } } } } };

function buildPrompt(batch, cal){
  return JSON.stringify({
    'сегодня': cal.ru, 'рабочих дней до конца месяца': cal.workdaysLeft,
    'менеджеры': batch.map(function(b){
      return { 'менеджер': b.managerName, 'поводы': b.picked.map(function(r, i){ return { id: b.slug + '-' + (i + 1), 'показатель': r.kpi, 'факты': clean(r.facts) }; }) };
    })
  }, null, 1);
}
function clean(o){ const r = {}; Object.keys(o).forEach(function(k){ if(o[k] !== null && o[k] !== undefined && !(Array.isArray(o[k]) && !o[k].length)) r[k] = o[k]; }); return r; }

function parseTips(text){
  const s = String(text || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  const j = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
  const map = new Map();
  (j.tips || []).forEach(function(t){ if(t && t.id && t.text) map.set(String(t.id), { title: String(t.title || '').trim(), text: String(t.text).trim() }); });
  if(!map.size) throw new Error('в ответе нет советов');
  return map;
}

function callClaude(prompt, env){
  return new Promise(function(resolve, reject){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tips-')); // пустая папка: Claude не видит репозиторий
    const args = ['-p', '--model', env.CLAUDE_MODEL || CLAUDE_MODEL, '--tools', '', '--system-prompt', SYSTEM,
      '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--json-schema', JSON.stringify(SCHEMA)];
    const childEnv = Object.assign({}, process.env);
    ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'EXPORT_PASSWORD', 'TIPS_STATE_KEY', 'PASSWORDS', 'MAIL_PASSWORD', 'GMAIL_APP_PASSWORD'].forEach(function(k){ delete childEnv[k]; });
    let child;
    try{ child = spawn(env.CLAUDE_BIN || 'claude', args, { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch(e){ return reject(e); }
    let out = '', err = '';
    const timer = setTimeout(function(){ child.kill('SIGKILL'); }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', function(d){ out += d; });
    child.stderr.on('data', function(d){ err += d; });
    child.on('error', function(e){ clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('Claude Code не установлен') : e); });
    child.on('close', function(code){
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      try{
        const j = JSON.parse(out);
        if(j.is_error) return reject(new Error('Claude: ' + String(j.result || j.subtype || 'ошибка').slice(0, 200)));
        const u = j.usage || {};
        console.log('  ℹ Claude: токенов — вход ' + ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) + ', выход ' + (u.output_tokens || 0));
        try{ resolve(parseTips(j.structured_output ? JSON.stringify(j.structured_output) : j.result)); }
        catch(e2){ reject(new Error('ответ не разобран (' + e2.message + ')' + (process.env.TIPS_DEBUG ? ': ' + j.result : ''))); }
      }catch(e){
        reject(new Error('Claude: код ' + code + ', ' + (err || out || e.message).replace(/\s+/g, ' ').slice(0, 200)));
      }
    });
    child.stdin.end(prompt);
  });
}

async function callGemini(prompt, env, model){
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, GEMINI_TIMEOUT_MS);
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
      }),
      signal: ctrl.signal
    });
    if(!res.ok){ const e = new Error('HTTP ' + res.status + ' [' + model + ']'); e.status = res.status; throw e; }
    const j = await res.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    return parseTips(parts.map(function(p){ return p.text || ''; }).join(''));
  } finally { clearTimeout(timer); }
}
async function callGeminiRetry(prompt, env){
  const models = [env.GEMINI_MODEL || GEMINI_MODEL];
  if(GEMINI_FALLBACK !== models[0]) models.push(GEMINI_FALLBACK);
  let last;
  for(const model of models){
    for(let i = 0; i <= GEMINI_RETRY_MS.length; i++){
      try{ return await callGemini(prompt, env, model); }
      catch(e){
        last = e;
        if(e.status && e.status !== 429 && e.status < 500) break;
        if(i < GEMINI_RETRY_MS.length) await new Promise(function(r){ setTimeout(r, GEMINI_RETRY_MS[i]); });
      }
    }
  }
  throw last;
}

async function write(batch, cal, env){
  const prompt = buildPrompt(batch, cal);
  const writers = [];
  if(env.CLAUDE_CODE_OAUTH_TOKEN) writers.push(['Claude', function(){ return callClaude(prompt, env); }]);
  if(env.GEMINI_API_KEY) writers.push(['Gemini', function(){ return callGeminiRetry(prompt, env); }]);
  let map = new Map(), by = 'шаблоны';
  for(const w of writers){
    try{ map = await w[1](); by = w[0]; break; }
    catch(e){ console.warn('  ⚠ ' + w[0] + ': ' + (e && e.message ? e.message : e) + (writers.indexOf(w) < writers.length - 1 ? ' — пробую дальше.' : '')); }
  }
  let filled = 0;
  const result = {};
  batch.forEach(function(b){
    result[b.slug] = b.picked.map(function(r, i){
      const t = map.get(b.slug + '-' + (i + 1));
      if(!t) filled++;
      const title = t && t.title ? t.title : (r.point ? r.point : r.kpi);
      return { title: (r.kpi + ': ' + title).slice(0, 90), text: String(t ? t.text : r.fallback).slice(0, 450) };
    });
  });
  const total = batch.reduce(function(a, b){ return a + b.picked.length; }, 0);
  console.log('  💡 Тексты советов: ' + by + (map.size && filled ? ' (ещё ' + filled + ' — готовым текстом)' : '') + ', всего ' + total);
  return { tips: result, by: by };
}

// pages: [{slug, payload, managerName?}]; opts: { exp } — сырая выгрузка 1С, если сборка из неё.
async function addTips(pages, env, opts){
  opts = opts || {};
  const cal = calendar();
  const stateFile = env.TIPS_STATE_FILE || null;
  const secret = env.TIPS_STATE_KEY || null;
  if(stateFile && !secret) console.warn('  ⚠ TIPS_STATE_KEY не задан — журнал советов не ведётся, возможны повторы.');
  const st = loadState(stateFile, secret);
  const mgrPages = pages.filter(function(p){ return p.managerName; });

  // советы уже готовили сегодня — берём их (если не просили пересоздать)
  const today = st.daily && st.daily.date === cal.iso && !env.TIPS_FORCE ? st.daily.tips || {} : {};
  const need = [];
  mgrPages.forEach(function(p){
    if(today[p.slug] && today[p.slug].length) p.payload.tips = today[p.slug];
    else need.push(p);
  });
  if(!need.length){ console.log('  💡 Советы на ' + cal.ru + ' уже готовы (' + (st.daily.by || '?') + ') — взяты из журнала.'); return; }

  const batch = [];
  need.forEach(function(p){
    try{
      const list = reasons.find({ payload: p.payload, managerName: p.managerName, today: cal.iso, exp: opts.exp, workdaysLeft: cal.workdaysLeft });
      const picked = select(list, st.history, p.managerName, cal);
      const stat = {}; list.forEach(function(r){ stat[r.type] = (stat[r.type] || 0) + 1; });
      console.log('  ℹ ' + p.slug + ': поводов ' + list.length + ' (' + Object.keys(stat).map(function(k){ return k + ' ' + stat[k]; }).join(', ') + '), выбрано ' + picked.length + ': ' + picked.map(function(r){ return r.type; }).join(', '));
      if(picked.length) batch.push({ slug: p.slug, managerName: p.managerName, picked: picked, page: p });
    }catch(e){
      console.warn('  ⚠ Поводы для «' + p.slug + '» не найдены (' + (e && e.message ? e.message : e) + ').');
    }
  });
  if(!batch.length) return;

  const res = await write(batch, cal, env);
  batch.forEach(function(b){ b.page.payload.tips = res.tips[b.slug]; });

  const history = st.history.filter(function(h){ return daysBetween(h.date, cal.iso) < HISTORY_DAYS && !(h.date === cal.iso && batch.some(function(b){ return b.managerName === h.mgr; })); });
  batch.forEach(function(b){ b.picked.forEach(function(r){ history.push({ date: cal.iso, mgr: b.managerName, key: r.key, point: r.point, type: r.type }); }); });
  const daily = { date: cal.iso, by: res.by, tips: Object.assign({}, today, res.tips) };
  try{ saveState(stateFile, secret, { history: history, daily: daily }); }
  catch(e){ console.warn('  ⚠ Журнал советов не сохранён: ' + e.message); }
}

module.exports = { addTips, select, calendar, loadState, saveState };
