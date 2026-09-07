// Làm rối JS trong dist/ sau khi ba bản vite build xong — MỨC CẦN THIẾT.
//
// Chỉ chạy ở `npm run build` (production), KHÔNG ở `npm run dev`.
//
// Mục tiêu: chặn người dùng mở code sửa để bỏ bước kiểm tra tài khoản. Thứ phục
// vụ điều đó là selfDefending (format/sửa lại -> code tự hỏng) + đổi tên định danh
// + giấu chuỗi. Đó là phần cốt lõi và RẺ. Các biến đổi đắt (control-flow
// flattening / dead-code injection ngưỡng cao, debugProtection) chỉ bật vừa phải
// hoặc tắt, vì chúng làm phình file nhiều lần và — với content.js chạy trên mọi
// trang — làm chậm cả việc lướt web mà không tăng bảo mật tương xứng.
//
// Hai ràng buộc MV3 mà script vẫn tự bảo đảm:
//  1. CSP cấm eval / new Function. Sau khi làm rối, quét lại output; nếu dính thì
//     dừng build (an toàn hơn là ra bản dist chết câm).
//  2. Output phải là JS hợp lệ — mỗi file được `node --check`.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import obfuscator from 'javascript-obfuscator';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

/** Nền chung — rẻ, không phá CSP, không dùng eval. */
const BASE = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  // Trái tim của "chống sửa": định dạng lại hoặc vá tay là code tự vỡ.
  selfDefending: true,
  // Tắt: chèn vòng lặp chặn DevTools, phiền và không tăng bảo mật thật.
  debugProtection: false,
};

/** popup + background chạy hiếm -> thêm chút control-flow + dead-code vừa phải. */
const STANDARD = {
  ...BASE,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
};

/**
 * content.js chạy ở document_start trên MỌI trang -> ưu tiên tốc độ.
 * Vẫn đổi tên + giấu chuỗi + selfDefending (đủ để không đọc/sửa tay được),
 * nhưng bỏ control-flow flattening và dead-code để không đội thời gian tải trang.
 */
const CONTENT = {
  ...BASE,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArrayThreshold: 0.6,
};

function profileFor(file) {
  return basename(file) === 'content.js' ? CONTENT : STANDARD;
}

/** Construct bị CSP của MV3 chặn. Có mặt = extension sẽ chết câm. */
function hasForbiddenConstruct(code) {
  return /\beval\s*\(/.test(code) || /\bFunction\s*\(\s*["'`]/.test(code) || /\bnew\s+Function\b/.test(code);
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = collectJsFiles(DIST);
if (files.length === 0) {
  console.error('obfuscate: không thấy file .js nào trong dist/. Đã build chưa?');
  process.exit(1);
}

let totalBefore = 0;
let totalAfter = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const output = obfuscator
    .obfuscate(source, { ...profileFor(file), inputFileName: basename(file) })
    .getObfuscatedCode();

  if (hasForbiddenConstruct(output)) {
    console.error(`obfuscate: ${basename(file)} chứa eval/Function -> vi phạm CSP MV3. Dừng build.`);
    process.exit(1);
  }

  writeFileSync(file, output, 'utf8');

  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch {
    console.error(`obfuscate: ${basename(file)} không qua node --check (cú pháp hỏng).`);
    process.exit(1);
  }

  totalBefore += source.length;
  totalAfter += output.length;
  const rel = file.replace(DIST, 'dist');
  const profile = basename(file) === 'content.js' ? 'content' : 'standard';
  console.log(
    `  ${rel}  (${profile})  ${(source.length / 1024).toFixed(0)}KB -> ${(output.length / 1024).toFixed(0)}KB`,
  );
}

console.log(
  `obfuscate: xong ${files.length} file, ${(totalBefore / 1024).toFixed(0)}KB -> ${(totalAfter / 1024).toFixed(0)}KB`,
);
