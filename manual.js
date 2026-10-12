#!/usr/bin/env node
// Ручная загрузка отчётов: расшифровывает manual.enc (его делает manual-pack.html)
// и запускает обычный сборщик на этих файлах. Сам сборщик не изменяется.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;

function fail(msg){
  console.error('\n❌ ОШИБКА РУЧНОЙ ЗАГРУЗКИ: ' + msg + '\n');
  process.exit(1);
}

const fileArg = (process.argv.slice(2).find(function(a){ return a.indexOf('--file=') === 0; }) || '').slice(7);
const encPath = path.resolve(ROOT, fileArg || 'manual.enc');

const password = process.env.MANUAL_PASSWORD;
if(!password) fail('Не задан секрет MANUAL_PASSWORD (Settings → Secrets and variables → Actions).');
if(!fs.existsSync(encPath)) fail('Файл ' + path.basename(encPath) + ' не найден в репозитории. Упакуйте отчёты в manual-pack.html и загрузите получившийся manual.enc в корень репозитория.');

// ---- расшифровка ----
const buf = fs.readFileSync(encPath);
if(buf.length < 4 + 16 + 12 + 16 || buf.subarray(0, 4).toString('latin1') !== 'DSM1'){
  fail('Файл ' + path.basename(encPath) + ' не похож на упакованные отчёты (его должна создавать страница manual-pack.html).');
}
const salt = buf.subarray(4, 20);
const iv = buf.subarray(20, 32);
const body = buf.subarray(32);
let payload;
try{
  const key = crypto.pbkdf2Sync(password.normalize('NFC'), salt, 600000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  payload = JSON.parse(plain.toString('utf8'));
}catch(e){
  fail('Не удалось расшифровать ' + path.basename(encPath) + ': пароль в секрете MANUAL_PASSWORD не совпадает с тем, что вводили при упаковке (или файл повреждён).');
}
if(!payload || payload.v !== 1 || !Array.isArray(payload.files) || !payload.files.length) fail('Внутри файла нет отчётов.');

// ---- проверка свежести (как для письма) ----
let maxAgeHours = 30;
try{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if(cfg.mail && Number(cfg.mail.maxAgeHours) > 0) maxAgeHours = Number(cfg.mail.maxAgeHours);
}catch(e){}
const created = new Date(payload.createdAt);
if(isNaN(created.getTime())) fail('В файле нет даты упаковки.');
const ageH = (Date.now() - created.getTime()) / 3600000;
if(ageH > maxAgeHours){
  fail('Упакованные отчёты старые: ' + created.toISOString() + ' (' + Math.round(ageH) + ' ч назад, лимит ' + maxAgeHours + ' ч). Упакуйте свежие файлы заново и загрузите manual.enc ещё раз.');
}
console.log('Расшифровано файлов: ' + payload.files.length + ', упаковано: ' + created.toISOString());

// ---- временная папка с файлами и запуск обычного сборщика ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-'));
try{
  payload.files.forEach(function(f){
    const name = path.basename(String(f.name || ''));
    if(!name) return;
    fs.writeFileSync(path.join(tmp, name), Buffer.from(String(f.data || ''), 'base64'));
  });
  const builder = ['src/build.js', 'build.js'].map(function(p){ return path.join(ROOT, p); }).find(fs.existsSync);
  if(!builder) fail('Не найден сборщик (src/build.js или build.js).');
  const res = spawnSync(process.execPath, [builder, '--source=dir:' + tmp, '--encrypt'], { cwd: ROOT, env: process.env, stdio: 'inherit' });
  process.exitCode = res.status === null ? 1 : res.status;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
