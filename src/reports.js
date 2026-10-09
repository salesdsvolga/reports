// Определение файлов по именам, разбор через парсеры и проверки согласованности.
const XLSX = require('xlsx');
const createParsers = require('./parsers');

function norm(s){ return String(s || '').toLowerCase().replace(/ё/g, 'е'); }

// files: [{filename, content: Buffer}] -> { key: {filename, content} }
function identify(files, cfg){
  const found = {};
  const skipped = [];
  files.forEach(function(f){
    const n = norm(f.filename);
    if(!/\.xlsx?$/.test(n)){ skipped.push(f.filename); return; }
    const hits = cfg.files.filter(function(d){ return d.match.every(function(w){ return n.indexOf(norm(w)) >= 0; }); });
    if(!hits.length){ skipped.push(f.filename); return; }
    if(hits.length > 1) throw new Error('Файл «' + f.filename + '» подходит сразу под несколько отчётов: ' + hits.map(function(h){ return h.key; }).join(', ') + '. Уточните правила в config.json (files → match).');
    const key = hits[0].key;
    if(found[key]) throw new Error('В письме два файла для отчёта «' + key + '»: «' + found[key].filename + '» и «' + f.filename + '».');
    found[key] = f;
  });
  const missing = cfg.files.map(function(d){ return d.key; }).filter(function(k){ return !found[k]; });
  if(missing.length){
    throw new Error('Не хватает отчётов: ' + missing.join(', ') + '. Вложения в письме: ' +
      (files.map(function(f){ return '«' + f.filename + '»'; }).join(', ') || 'нет') + '.');
  }
  return { found: found, skipped: skipped };
}

function parseAll(found, cfg){
  const P = createParsers(XLSX, { managers: cfg.managers.map(function(m){ return m.name; }), fullMml: cfg.fullMml });
  const res = {};
  cfg.files.forEach(function(d){
    const f = found[d.key];
    let wb;
    try{ wb = XLSX.read(f.content, { type: 'buffer' }); }
    catch(e){ throw new Error('Не удалось открыть файл «' + f.filename + '» (' + d.key + '): ' + e.message); }
    let r;
    try{
      if(d.kind === 'channel') r = P.parseChannelWorkbook(wb, d.key);
      else if(d.kind === 'sales') r = P.parseSalesWorkbook(wb);
      else if(d.kind === 'dark') r = P.parseDarkWorkbook(wb);
      else r = P.parseKpiWorkbook(wb);
    }catch(e){
      throw new Error('Ошибка разбора отчёта «' + d.key + '» (файл «' + f.filename + '»): ' + e.message + '. Возможно, 1С изменила формат отчёта.');
    }
    if(!r.data.length){
      throw new Error('В отчёте «' + d.key + '» не нашлось ни одной точки для менеджеров из config.json. Проверьте файл.');
    }
    res[d.key] = { data: r.data, period: r.period, filename: f.filename, kind: d.kind };
  });
  return res;
}

// Проверки: периоды должны совпадать внутри групп (иначе в письме смешаны разные месяцы).
function checkPeriods(parsed){
  const groups = {
    'ММЛ (Хорека, Розница)': ['Хорека', 'Розница'],
    'месячные отчёты (АКБ, аксессуары, ЭСДН, тёмные силы)': ['Продажи АКБ', 'Кальяны и аксессуары', 'ЭСДН', 'Тёмные силы']
  };
  Object.keys(groups).forEach(function(g){
    const ps = groups[g].map(function(k){ return parsed[k].period; });
    if(ps.some(function(p){ return !p; })){
      throw new Error('В отчёте не найден период («Период: …») — группа: ' + g + '.');
    }
    if(ps.some(function(p){ return p !== ps[0]; })){
      throw new Error('Периоды отчётов не совпадают (' + g + '): ' + groups[g].map(function(k, i){ return k + ' — ' + ps[i]; }).join('; ') + '. Похоже, в письме смешаны разные выгрузки.');
    }
  });
}

// Собирает то же содержимое, что раньше собирала админ-панель.
function assemble(parsed, generatedAt){
  const order = ['Хорека', 'Розница', 'Продажи АКБ', 'Кальяны и аксессуары', 'ЭСДН', 'Тёмные силы'];
  const meta = { channels: {}, generatedAt: generatedAt };
  order.forEach(function(k){
    meta.channels[k] = { period: parsed[k].period, filename: parsed[k].filename, count: parsed[k].data.length };
  });
  return {
    data: parsed['Хорека'].data.concat(parsed['Розница'].data),
    meta: meta,
    sales: parsed['Продажи АКБ'].data,
    accessories: parsed['Кальяны и аксессуары'].data,
    esdn: parsed['ЭСДН'].data,
    dark: parsed['Тёмные силы'].data
  };
}

module.exports = { identify, parseAll, checkPeriods, assemble };
