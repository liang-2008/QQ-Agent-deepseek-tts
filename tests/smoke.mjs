// 自检：不联网、不需要 Key。跑法：node tests/smoke.mjs
//
// 覆盖：地址拼接、配置清洗、文本清洗、计费字符、PCM 补头、WAV 完整性校验、
//      整段合成（成功 / 400 / 空音频 / PCM 模式）、流式合成（成功 / 内容审核 / 断线回落）、
//      字数上限、available()、registerTool 的参数表。

import {
  ttsEndpoint,
  wsEndpoint,
  normalizeVoice,
  readConfig,
  normalizeSpeakText,
  billingChars,
  pcmToWav,
  inspectWav,
  errorDetail,
  httpHint,
  synthesize,
  synthesizeWs,
  setup,
  available
} from '../index.js';

let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}：${error?.message ?? error}`);
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

async function okAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}：${error?.message ?? error}`);
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what || '值'}不对：期望 ${e}，实际 ${a}`);
}

function includes(haystack, needle, what = '') {
  if (!String(haystack).includes(needle)) throw new Error(`${what || '文本'}里没有「${needle}」：${haystack}`);
}

function throws(fn, needle) {
  try {
    fn();
  } catch (error) {
    if (needle) includes(String(error?.message ?? error), needle, '错误信息');
    return;
  }
  throw new Error(`本该报错却没报（期望包含「${needle}」）`);
}

async function rejects(promise, needle) {
  try {
    await promise;
  } catch (error) {
    if (needle) includes(String(error?.message ?? error), needle, '错误信息');
    return error;
  }
  throw new Error(`本该失败却成功了（期望包含「${needle}」）`);
}

/** 造一段 0.1 秒的 24kHz 单声道 WAV。 */
function fakeWav(seconds = 0.1) {
  const pcm = Buffer.alloc(Math.round(48000 * seconds), 0x11);
  return pcmToWav(pcm);
}

// ── ① 地址拼接 ────────────────────────────────────────────────────────────
console.log('\n[1] 接口地址');
ok('裸域名补 /v1/tools/tts', () => eq(ttsEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/tools/tts'));
ok('带尾斜杠也认', () => eq(ttsEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/tools/tts'));
ok('/v1 只补 /tools/tts', () => eq(ttsEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/tools/tts'));
ok('/v1/ 也认', () => eq(ttsEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/tools/tts'));
ok('全路径不重复拼', () => eq(ttsEndpoint('https://api.deepseek.com/v1/tools/tts'), 'https://api.deepseek.com/v1/tools/tts'));
ok('/tools 补 /tts', () => eq(ttsEndpoint('https://api.deepseek.com/v1/tools'), 'https://api.deepseek.com/v1/tools/tts'));
ok('空值用官方默认', () => eq(ttsEndpoint(''), 'https://api.deepseek.com/v1/tools/tts'));
ok('中转地址保留', () => eq(ttsEndpoint('https://my-proxy.example.com/api'), 'https://my-proxy.example.com/api/v1/tools/tts'));
ok('ws 地址换协议', () => eq(wsEndpoint('https://api.deepseek.com'), 'wss://api.deepseek.com/v1/tools/tts'));
ok('http 地址换 ws', () => eq(wsEndpoint('http://127.0.0.1:9000'), 'ws://127.0.0.1:9000/v1/tools/tts'));

// ── ② 音色 & 配置 ─────────────────────────────────────────────────────────
console.log('\n[2] 音色与配置');
ok('音色白名单', () => { eq(normalizeVoice('stella'), 'stella'); eq(normalizeVoice('TIDE'), 'tide'); });
ok('中文/近义词回落到官方 ID', () => { eq(normalizeVoice('海星'), 'stella'); eq(normalizeVoice('暗潮'), 'tide'); eq(normalizeVoice('女声'), 'stella'); });
ok('认不出的音色返回空', () => eq(normalizeVoice('冰糖'), ''));

ok('默认配置', () => {
  const c = readConfig({ apiKey: ' sk-test ' });
  eq(c.apiKey, 'sk-test');
  eq(c.baseUrl, 'https://api.deepseek.com/v1/tools/tts');
  eq(c.voiceId, 'stella');
  eq(c.format, 'wav');
  eq(c.transport, 'http');
  eq(c.filterMarkdown, true);
  eq(c.maxChars, 120);
  eq(c.timeoutMs, 60000);
  eq(c.alsoSendText, false);
});

ok('配置夹取范围', () => {
  const c = readConfig({ apiKey: 'k', voiceId: 'tide', maxChars: '99999', timeoutMs: 1, format: 'mp3', transport: 'STREAM' });
  eq(c.maxChars, 2000);
  eq(c.timeoutMs, 5000);
  eq(c.format, 'wav', '未知格式回落 wav');
  eq(c.transport, 'ws', 'stream 视作 ws');
  eq(c.voiceId, 'tide');
});

ok('配置下限', () => {
  const c = readConfig({ maxChars: 1, timeoutMs: 0 });
  eq(c.maxChars, 20);
  eq(c.timeoutMs, 60000);
});

ok('filterMarkdown 显式 false 生效', () => eq(readConfig({ filterMarkdown: false }).filterMarkdown, false));

// ── ③ 文本清洗 ────────────────────────────────────────────────────────────
console.log('\n[3] 文本清洗');
ok('去加粗与行内代码', () => eq(normalizeSpeakText('**你好**，`world`！'), '你好，world！'));
ok('去标题与列表，换行变逗号', () => eq(normalizeSpeakText('# 标题\n- 第一条\n2. 第二条'), '标题，第一条，第二条'));
ok('去代码块', () => eq(normalizeSpeakText('看这个：\n```js\nconst a = 1;\n```\n就这样'), '看这个：，就这样'));
ok('链接只留文字', () => eq(normalizeSpeakText('见[文档](https://x.com/a)'), '见文档'));
ok('裸链接念成「链接」', () => eq(normalizeSpeakText('打开 https://x.com/a 看'), '打开 链接 看'));
ok('去表情符号', () => eq(normalizeSpeakText('看我 😀👍🏻'), '看我'));
ok('去动作括号', () => eq(normalizeSpeakText('我不管（笑）'), '我不管'));
ok('斜体', () => eq(normalizeSpeakText('这是 *重点* 哦'), '这是 重点 哦'));
ok('收尾标点不残留', () => eq(normalizeSpeakText('你好，，。'), '你好。'));
ok('全是符号时洗成空串', () => eq(normalizeSpeakText('**😀** ～～'), ''));

// ── ④ 计费字符 ────────────────────────────────────────────────────────────
console.log('\n[4] 计费字符');
ok('汉字算 2', () => eq(billingChars('你好'), 4));
ok('英文数字算 1', () => eq(billingChars('ab 12'), 5));
ok('混合', () => eq(billingChars('你好ab'), 6));

// ── ⑤ PCM / WAV ───────────────────────────────────────────────────────────
console.log('\n[5] PCM 补 WAV 头与完整性校验');
ok('补出的头是合法 WAV', () => {
  const pcm = Buffer.alloc(4800, 0x22);
  const wav = pcmToWav(pcm);
  eq(wav.length, 44 + 4800);
  eq(wav.subarray(0, 4).toString('latin1'), 'RIFF');
  eq(wav.subarray(8, 12).toString('latin1'), 'WAVE');
  eq(wav.readUInt32LE(4), 36 + 4800);
  eq(wav.readUInt32LE(24), 24000, '采样率');
  eq(wav.readUInt16LE(22), 1, '声道数');
  eq(wav.readUInt16LE(34), 16, '位深');
  eq(wav.readUInt32LE(40), 4800, 'data 长度');
});

ok('inspectWav 算出时长', () => {
  const info = inspectWav(fakeWav(0.5));
  eq(info.ok, true);
  if (Math.abs(info.seconds - 0.5) > 0.001) throw new Error(`时长不对：${info.seconds}`);
});

ok('截断的 WAV 会被抓出来', () => {
  const full = fakeWav(0.5);
  const info = inspectWav(full.subarray(0, full.length - 1000));
  eq(info.ok, false);
  includes(info.reason, '中途断开', '原因');
});

ok('空的 data 段会被抓出来', () => {
  const info = inspectWav(pcmToWav(Buffer.alloc(0)));
  eq(info.ok, false);
  includes(info.reason, '空', '原因');
});

ok('不是 WAV 的东西会被抓出来', () => {
  const info = inspectWav(Buffer.from('{"error":"x"}'));
  eq(info.ok, false);
});

// ── ⑥ 错误翻译 ────────────────────────────────────────────────────────────
console.log('\n[6] 错误翻译');
ok('从 JSON 错误体里捞 message', () => {
  includes(errorDetail(Buffer.from('{"error":{"message":"Content Exists Risk"}}')), 'Content Exists Risk');
});
ok('纯文本错误体原样截断', () => includes(errorDetail(Buffer.from('  gateway   timeout ')), 'gateway timeout'));
ok('400 的提示提到内容审核', () => includes(httpHint(400), '内容审核'));
ok('429 的提示提到并发', () => includes(httpHint(429), '并发'));
ok('404 的提示提到地址', () => includes(httpHint(404), '接口地址'));

// ── ⑦ 整段合成 ────────────────────────────────────────────────────────────
console.log('\n[7] 整段合成（HTTP）');

function makeHttpFetch({ body = null, status = 200, contentType = 'audio/wav', capture = [] } = {}) {
  return async (url, init) => {
    capture.push({ url, init });
    const payload = body ?? fakeWav(0.2);
    return new Response(payload, { status, headers: { 'content-type': contentType } });
  };
}

const BASE_CFG = { apiKey: 'sk-test', voiceId: 'stella', maxChars: 120, timeoutMs: 20000 };

await okAsync('请求体与鉴权头正确', async () => {
  const capture = [];
  const r = await synthesize({ text: '你好呀' }, { cfg: BASE_CFG, fetchImpl: makeHttpFetch({ capture }) });
  const req = capture[0];
  eq(req.url, 'https://api.deepseek.com/v1/tools/tts');
  eq(req.init.method, 'POST');
  eq(req.init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(req.init.body);
  eq(body.text, '你好呀');
  eq(body.voice_id, 'stella');
  eq(body.format, 'wav');
  eq(body.filter_markdown, true);
  eq(r.format, 'wav');
  eq(r.transport, 'http');
  eq(r.audioB64.startsWith('UklGR'), true, 'base64 应该是 WAV（RIFF）');
});

await okAsync('单句覆盖音色', async () => {
  const capture = [];
  await synthesize({ text: '你好', voice: 'tide' }, { cfg: BASE_CFG, fetchImpl: makeHttpFetch({ capture }) });
  eq(JSON.parse(capture[0].init.body).voice_id, 'tide');
});

await okAsync('PCM 模式会被补成 WAV', async () => {
  const pcm = Buffer.alloc(4800, 0x33);
  const r = await synthesize({ text: '你好' }, {
    cfg: { ...BASE_CFG, format: 'pcm' },
    fetchImpl: makeHttpFetch({ body: pcm, contentType: 'audio/pcm' })
  });
  const audio = Buffer.from(r.audioB64, 'base64');
  eq(audio.subarray(0, 4).toString('latin1'), 'RIFF');
  eq(audio.length, 44 + 4800);
  eq(r.format, 'wav');
});

await okAsync('400 带出官方原因与建议', async () => {
  const error = await rejects(synthesize({ text: '你好' }, {
    cfg: BASE_CFG,
    fetchImpl: makeHttpFetch({
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ error: { message: 'Content Exists Risk' } }))
    })
  }), 'HTTP 400');
  includes(error.message, '内容审核', '错误信息');
  includes(error.message, 'Content Exists Risk', '错误信息');
});

await okAsync('200 但音频为空会报错', async () => {
  await rejects(synthesize({ text: '你好' }, {
    cfg: BASE_CFG,
    fetchImpl: makeHttpFetch({ body: Buffer.alloc(0), contentType: 'audio/wav' })
  }), '空');
});

await okAsync('200 但返回 JSON 会报错', async () => {
  await rejects(synthesize({ text: '你好' }, {
    cfg: BASE_CFG,
    fetchImpl: makeHttpFetch({
      contentType: 'application/json',
      body: Buffer.from('{"error":{"message":"model not found"}}')
    })
  }), 'JSON');
});

await okAsync('中途断掉的音频不会发出去', async () => {
  const full = fakeWav(0.5);
  await rejects(synthesize({ text: '你好' }, {
    cfg: BASE_CFG,
    fetchImpl: makeHttpFetch({ body: full.subarray(0, full.length - 500), contentType: 'audio/wav' })
  }), '不完整');
});

await okAsync('没填 Key 直接报错', async () => {
  await rejects(synthesize({ text: '你好' }, { cfg: { ...BASE_CFG, apiKey: '' }, fetchImpl: makeHttpFetch() }), 'API Key');
});

await okAsync('超字数直接拒发', async () => {
  await rejects(synthesize({ text: '好'.repeat(30) }, { cfg: { ...BASE_CFG, maxChars: 20 }, fetchImpl: makeHttpFetch() }), '太长');
});

await okAsync('洗完是空文本也拒发', async () => {
  await rejects(synthesize({ text: '😀😀**' }, { cfg: BASE_CFG, fetchImpl: makeHttpFetch() }), '空的');
});

await okAsync('fetch 超时会给出人话', async () => {
  const timeoutFetch = async () => {
    const error = new Error('signal timed out');
    error.name = 'TimeoutError';
    throw error;
  };
  await rejects(synthesize({ text: '你好' }, { cfg: BASE_CFG, fetchImpl: timeoutFetch }), '超时');
});

// ── ⑧ 流式合成 ────────────────────────────────────────────────────────────
console.log('\n[8] 流式合成（WebSocket）');

class FakeWS {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = false;
    this.binaryType = '';
    FakeWS.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
}

await okAsync('子协议鉴权 + 分段送文本 + 拼 PCM', async () => {
  FakeWS.instances = [];
  const pcm = Buffer.alloc(4800, 0x44);
  const p = synthesizeWs(readConfig({ ...BASE_CFG, transport: 'ws' }), '你好呀', FakeWS);
  const ws = FakeWS.instances[0];
  eq(ws.protocols, ['tts', 'bearer.sk-test'], '子协议');
  includes(ws.url, 'wss://api.deepseek.com/v1/tools/tts?', '地址');
  includes(ws.url, 'voice_id=stella', '地址');
  includes(ws.url, 'format=pcm', '地址');

  ws.onopen();
  eq(ws.sent.length, 2, '应当先发 text 再发 finish_text');
  eq(JSON.parse(ws.sent[0]), { event: 'text', text: '你好呀' });
  eq(JSON.parse(ws.sent[1]), { event: 'finish_text' });

  ws.onmessage({ data: pcm.subarray(0, 2400) });
  ws.onmessage({ data: pcm.subarray(2400) });
  ws.onmessage({ data: JSON.stringify({ event: 'finish', code: 'success', message: '' }) });

  const r = await p;
  eq(r.transport, 'ws');
  eq(r.bytes, 44 + 4800);
  const audio = r.audioBuf;
  eq(audio.subarray(0, 4).toString('latin1'), 'RIFF');
});

await okAsync('内容审核不回落 http，直接报错', async () => {
  FakeWS.instances = [];
  const p = synthesizeWs(readConfig({ ...BASE_CFG, transport: 'ws' }), '你好', FakeWS);
  const ws = FakeWS.instances[0];
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ event: 'finish', code: 'content_filter', message: 'risky' }) });
  const error = await rejects(p, 'content_filter');
  includes(error.message, '内容审核', '错误信息');
});

await okAsync('没收到音频就 finish 会报错', async () => {
  FakeWS.instances = [];
  const p = synthesizeWs(readConfig({ ...BASE_CFG, transport: 'ws' }), '你好', FakeWS);
  FakeWS.instances[0].onopen();
  FakeWS.instances[0].onmessage({ data: JSON.stringify({ event: 'finish', code: 'success' }) });
  await rejects(p, '一帧音频都没收到');
});

await okAsync('断线时自动回落整段合成', async () => {
  FakeWS.instances = [];
  const capture = [];
  const p = synthesize({ text: '你好' }, {
    cfg: { ...BASE_CFG, transport: 'ws' },
    wsImpl: FakeWS,
    fetchImpl: makeHttpFetch({ capture })
  });
  FakeWS.instances[0].onerror({ message: 'ECONNRESET' });
  const r = await p;
  eq(r.transport, 'http');
  eq(r.fellBack, true);
  eq(capture.length, 1, '应当回落到一次 http 请求');
});

await okAsync('环境没有 WebSocket 时给出明确提示', async () => {
  const c = readConfig({ ...BASE_CFG, transport: 'ws' });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  try {
    throws(() => synthesizeWs(c, '你好', undefined), '没有 WebSocket');
  } finally {
    globalThis.WebSocket = original;
  }
});

// ── ⑨ 生命周期 ────────────────────────────────────────────────────────────
console.log('\n[9] 技能注册与自检');

let tool = null;
const api = {
  config: () => ({ apiKey: 'sk-test' }),
  log: () => {},
  fetch: async () => new Response(fakeWav(0.1), { status: 200, headers: { 'content-type': 'audio/wav' } }),
  registerTool: (t) => { tool = t; }
};
setup(api);

ok('注册了 say 工具', () => {
  if (!tool) throw new Error('没有注册工具');
  eq(tool.id, 'say');
  eq(tool.parameters.required, ['text']);
  eq(Object.keys(tool.parameters.properties).sort(), ['replyToMessageId', 'text', 'voice'].sort());
});

ok('available() 通过', () => eq(available().ok, true));

ok('available() 能指出没填 Key', () => {
  const saved = api.config;
  api.config = () => ({ apiKey: '' });
  setup(api);
  const r = available();
  eq(r.ok, false);
  includes(r.reason, 'API Key', '原因');
  api.config = saved;
  setup(api);
});

await okAsync('execute 会把音频交给 sendMedia', async () => {
  const media = [];
  const ctx = {
    chatKey: 'group:1',
    sender: {
      sendMedia: async (key, segments, opts) => { media.push({ key, segments, opts }); },
      sendTextBatch: async () => {}
    },
    session: { sent: [] },
    emit: () => {}
  };
  const r = await tool.execute(ctx, { text: '晚安' });
  includes(r.content, '晚安', '返回内容');
  eq(media.length, 1);
  eq(media[0].segments[0].type, 'record');
  eq(media[0].segments[0].data.file.startsWith('base64://'), true, '音频段');
  eq(ctx.session.sent.length, 1);
});

await okAsync('execute 出错时返回 isError 与人话', async () => {
  const r = await tool.execute({ chatKey: 'g', sender: { sendMedia: async () => {} } }, { text: '😀**' });
  eq(r.isError, true);
  includes(r.content, '空的', '返回内容');
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${failures.length ? '✗' : '✓'} ${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
