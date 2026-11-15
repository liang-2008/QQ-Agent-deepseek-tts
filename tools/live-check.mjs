// 真机自检：真的调一次官方接口，把音频写到磁盘上听一听。
// 这个脚本不参与插件运行，只在你自己机器上手动用。
//
//   PowerShell:
//     $env:DEEPSEEK_API_KEY = "sk-..."
//     node tools/live-check.mjs "你好，我是你的语音。"
//
//   可选参数：
//     --voice tide      换男声（默认 stella）
//     --pcm             请求裸 PCM，验证「补 WAV 头」那条路
//     --ws              走 WebSocket 流式合成
//     --out a.wav       输出文件（默认 out.wav）
//
// 成功时打印字节数、时长和估算费用，并用系统播放器打开（Windows）。

import fs from 'node:fs';
import path from 'node:path';
import { synthesize, readConfig, billingChars, inspectWav } from '../index.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const text = (() => {
  const takesValue = new Set(['--voice', '--out', '--key']);
  for (let i = 0; i < argv.length; i++) {
    if (takesValue.has(argv[i])) { i++; continue; }
    if (!argv[i].startsWith('--')) return argv[i];
  }
  return '';
})() || '你好，我是 DeepSeek 的语音合成，这是一条测试语音。';
const apiKey = process.env.DEEPSEEK_API_KEY || value('--key', '');
if (!apiKey) {
  console.error('缺 Key：先设置 $env:DEEPSEEK_API_KEY="sk-..."，或加 --key sk-...');
  process.exit(2);
}

const cfg = readConfig({
  apiKey,
  voiceId: value('--voice', 'stella'),
  format: flag('--pcm') ? 'pcm' : 'wav',
  transport: flag('--ws') ? 'ws' : 'http',
  maxChars: 2000,
  timeoutMs: 120000
});

console.log(`接口：${cfg.baseUrl}`);
console.log(`音色：${cfg.voiceId} · 方式：${cfg.transport} · 请求格式：${cfg.format}`);
console.log(`文本：${text}（计费约 ${billingChars(text)} 字符）`);

const started = Date.now();
try {
  const r = await synthesize({ text }, { cfg, fetchImpl: fetch });
  const out = path.resolve(value('--out', 'out.wav'));
  const audio = Buffer.from(r.audioB64, 'base64');
  fs.writeFileSync(out, audio);
  const info = inspectWav(audio);
  console.log(`\n✓ 合成成功（${Date.now() - started}ms）`);
  console.log(`  实际念的：${r.spoken}`);
  console.log(`  文件：${out}`);
  console.log(`  大小：${r.bytes} 字节 · 时长约 ${r.seconds.toFixed(2)} 秒 · 传输 ${r.transport}${r.fellBack ? '（流式失败后回落）' : ''}`);
  console.log(`  校验：${info.ok ? 'WAV 完整' : `有问题——${info.reason}`}`);
  console.log(`  估算费用：约 ${(r.billing * 3 / 20000).toFixed(4)} 元（每万字符 3 元，现价 5 折）`);

  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${out}'`], { stdio: 'ignore', detached: true }).unref();
  }
} catch (error) {
  console.error(`\n✗ 失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
