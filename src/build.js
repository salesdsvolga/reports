#!/usr/bin/env node
// Сборка страниц для менеджеров.
//   node src/build.js --source=mail --encrypt     (так работает GitHub Actions)
//   node src/build.js --source=dir:samples        (проверка на файлах из папки, без почты)
//   node src/build.js --source=eml:letter.eml     (проверка на сохранённом письме)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const reports = require('./reports');
const mail = require('./mail');

const ROOT = path.resolve(__dirname, '..');
const args = {};
process.argv.slice(2).forEach(function(a){
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if(m) args[m[1]] = m[2] === undefined ? true : m[2];
});
const OUT = path.resolve(ROOT, args.out || 'out');
const WORK = path.resolve(ROOT, 'work');

function fail(msg){
  console.error('\n❌ ОШИБКА СБОРКИ: ' + msg + '\n');
  process.exit(1);
}

function readJson(p){
  try{ return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch(e){ fail('Не удалось прочитать ' + path.relative(ROOT, p) + ': ' + e.message + ' (проверьте запятые и кавычки).'); }
}

function formatDate(d, tz){
  const parts = {};
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).forEach(function(p){ parts[p.type] = p.value; });
  return parts.day + '.' + parts.month + '.' + parts.year + ', ' + parts.hour + ':' + parts.minute;
}

function shortName(full){
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return parts.length >= 3 ? parts[0] + ' ' + parts[1] : full;
}

function jsonForHtml(obj){
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function renderPage(template, payload, title){
  const re = /<script id="ttdata" type="application\/json">[\s\S]*?<\/script>/;
  if(!re.test(template)) fail('В template.html не найден блок <script id="ttdata">.');
  let html = template.replace(re, function(){ return '<script id="ttdata" type="application/json">' + jsonForHtml(payload) + '</script>'; });
  html = html.replace(/<title>[\s\S]*?<\/title>/, function(){ return '<title>' + title.replace(/</g, '&lt;') + '</title>'; });
  return html;
}

function parsePasswords(text){
  const map = {};
  String(text || '').split(/\r?\n/).forEach(function(line){
    const m = /^\s*([A-Za-z0-9_-]+)\s*[=:]\s*(.+?)\s*$/.exec(line);
    if(m) map[m[1]] = m[2];
  });
  return map;
}

function encryptPage(plainPath, outDir, password){
  const bin = require.resolve('staticrypt/cli/index.js');
  // staticrypt ждёт относительные пути, поэтому запускаем из корня проекта
  execFileSync(process.execPath, [bin, path.relative(ROOT, plainPath), '-d', path.relative(ROOT, outDir), '-c', '.staticrypt.json', '--short',
    '--template-title', 'Отчёт по дистрибуции',
    '--template-instructions', 'Введите пароль, который вам выдали',
    '--template-placeholder', 'Пароль',
    '--template-button', 'Открыть',
    '--template-error', 'Неверный пароль',
    '--template-remember', 'Запомнить на этом устройстве',
    '--template-color-primary', '#e08a34',
    '--template-color-secondary', '#171512'
  ], { cwd: ROOT, env: Object.assign({}, process.env, { STATICRYPT_PASSWORD: password }), stdio: ['ignore', 'ignore', 'inherit'] });
}

async function main(){
  const cfg = readJson(path.join(ROOT, 'config.json'));
  let plans = readJson(path.join(ROOT, 'plans.json'));
  if(process.env.PLANS_JSON){
    try{ plans = JSON.parse(process.env.PLANS_JSON); console.log('Планы взяты из переменной PLANS_JSON.'); }
    catch(e){ fail('Переменная PLANS_JSON содержит некорректный JSON: ' + e.message); }
  }
  const template = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8');

  // 1. получить файлы
  const source = String(args.source || 'mail');
  let got;
  if(source === 'mail'){ got = await mail.fetchFromMail(cfg, process.env); }
  else if(source.indexOf('dir:') === 0){
    const dir = path.resolve(ROOT, source.slice(4));
    got = { files: fs.readdirSync(dir).map(function(n){ return { filename: n, content: fs.readFileSync(path.join(dir, n)) }; }), date: new Date() };
  } else if(source.indexOf('eml:') === 0){
    got = await mail.readEml(fs.readFileSync(path.resolve(ROOT, source.slice(4))));
  } else fail('Неизвестный --source: ' + source);

  // 2. найти, разобрать, проверить
  const ident = reports.identify(got.files, cfg);
  const parsed = reports.parseAll(ident.found, cfg);
  reports.checkPeriods(parsed);
  if(ident.skipped.length) console.log('Пропущены лишние вложения: ' + ident.skipped.join(', '));

  const generatedAt = formatDate(got.date, cfg.timezone);
  const all = reports.assemble(parsed, generatedAt);

  console.log('Письмо от: ' + generatedAt + ' (' + cfg.timezone + ')');
  cfg.files.forEach(function(d){
    const p = parsed[d.key];
    console.log('  ' + d.key.padEnd(22) + String(p.data.length).padStart(4) + ' строк · период ' + p.period);
  });

  // 3. страницы
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'plain'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const pages = [];
  cfg.managers.forEach(function(mg){
    const f = function(arr){ return arr.filter(function(e){ return e.m === mg.name; }); };
    const payload = {
      data: f(all.data), meta: all.meta, sales: f(all.sales), accessories: f(all.accessories),
      esdn: f(all.esdn), dark: f(all.dark),
      plans: {
        'Аксессуары': Number((plans['Аксессуары'] || {})[mg.name]) || 0,
        'ЭСДН': Number((plans['ЭСДН'] || {})[mg.name]) || 0
      }
    };
    const rows = payload.data.length + payload.sales.length + payload.accessories.length + payload.esdn.length + payload.dark.length;
    if(!payload.data.length || !payload.sales.length){
      console.warn('  ⚠ у менеджера «' + mg.name + '» нет данных в ММЛ или «Продажи АКБ» — проверьте, что менеджер записан в отчётах так же, как в config.json.');
    }
    if(!rows) return console.warn('  ⚠ для «' + mg.name + '» данных нет вообще, страница не создаётся.');
    pages.push({ slug: mg.slug, title: 'Незакупленные позиции — ' + shortName(mg.name), payload: payload,
      info: mg.name + ': позиций ' + payload.data.length + ', АКБ ' + payload.sales.length + ', аксессуары ' + payload.accessories.length + ', ЭСДН ' + payload.esdn.length + ', тёмные силы ' + payload.dark.length });
  });
  if(cfg.allPage && cfg.allPage.enabled){
    pages.push({ slug: cfg.allPage.slug, title: 'Незакупленные позиции — ' + cfg.allPage.title,
      payload: Object.assign({}, all, { plans: { 'Аксессуары': plans['Аксессуары'] || {}, 'ЭСДН': plans['ЭСДН'] || {} } }),
      info: 'Общая страница: все менеджеры' });
  }
  if(!pages.length) fail('Ни одной страницы не получилось собрать.');

  pages.forEach(function(p){
    fs.writeFileSync(path.join(WORK, 'plain', p.slug + '.html'), renderPage(template, p.payload, p.title));
  });

  // 4. пароли
  if(args.encrypt){
    const pw = parsePasswords(process.env.PASSWORDS);
    const noPw = pages.filter(function(p){ return !pw[p.slug]; }).map(function(p){ return p.slug; });
    if(noPw.length) fail('Не заданы пароли для страниц: ' + noPw.join(', ') + '. Добавьте строки вида «' + noPw[0] + '=12345678» в секрет PASSWORDS. Без пароля страницы не публикуются.');
    pages.forEach(function(p){
      encryptPage(path.join(WORK, 'plain', p.slug + '.html'), OUT, pw[p.slug]);
      console.log('  🔒 ' + p.slug + '.html — ' + p.info);
    });
  } else {
    pages.forEach(function(p){
      fs.copyFileSync(path.join(WORK, 'plain', p.slug + '.html'), path.join(OUT, p.slug + '.html'));
      console.log('  📄 ' + p.slug + '.html (БЕЗ пароля, только для проверки) — ' + p.info);
    });
  }
  fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Отчёты</title><body style="font-family:sans-serif;background:#171512;color:#b8ad9c;padding:40px">Отчёты доступны по персональной ссылке.</body>');
  console.log('\n✅ Готово: ' + path.relative(ROOT, OUT) + '/ (' + pages.length + ' стр.)');
}

main().catch(function(e){ fail(e && e.message ? e.message : String(e)); });
