// 语音说话（DeepSeek 官方 TTS）：让机器人把一句话「说出来」，而不只是打字。
//
// 只有一条路：DeepSeek 官方语音合成接口。
//   整段  POST https://api.deepseek.com/v1/tools/tts
//         body { text, voice_id, format, filter_markdown }
//         → 响应体**直接就是音频字节**（wav / pcm），边合成边返回，不是 JSON
//   流式  WSS  wss://api.deepseek.com/v1/tools/tts?voice_id=&format=pcm&filter_markdown=
//         发 {"event":"text","text":"…"} … 再发 {"event":"finish_text"}，
//         收二进制音频帧，最后收 {"event":"finish","code":"success|…"}
// 拿到音频字节统一 → ctx.sender.sendMedia() 发 record 段 → QQ 里是一颗语音气泡。
//
// ── 和上一版（mimo-tts / 百炼 / 小米）最大的差别 ────────────────────────
//   ① 没有 mp3。官方只给 wav 和 pcm。pcm 是 24kHz / 16bit / 单声道的**裸数据**，
//      没有文件头，直接发给 QQ 会转码失败，所以插件自己补 44 字节 WAV 头。
//   ② 没有情绪/语速/方言参数，也没有音色克隆。音色只有 stella（女）和 tide（男）
//      两个固定 ID。想换味道只能改措辞——长短句、语气词、标点。voice.txt 那套
//      「用文字描述造音色」在这儿没有任何作用，已经删掉了。
//   ③ 鉴权只有 Bearer。WebSocket 传不了自定义请求头，官方给的办法是子协议：
//      Sec-WebSocket-Protocol: tts, bearer.<API Key>  → 这里就是 ['tts', 'bearer.…']
//   ④ 计费按字符算，汉字算 2 个（每万字符 3 元，现价 5 折）。日志里会报大概花了多少。
//   ⑤ 音频已经开始返回后合成失败会**中途断开**，不会给错误码。所以插件收到字节后
//      会验一遍 WAV 的 RIFF/data 长度，短了就当失败重试，而不是把半截音频发出去。
//
// ── 为什么不用 WebSocket 当默认 ─────────────────────────────────────────
//   QQ 语音要的是「一个完整音频文件」，不是边播边收；http 一次拿全最简单，
//   也少一层 Node 版本依赖（全局 WebSocket 要 Node 22+）。ws 留给需要长文本 /
//   网络不稳的场景，失败会自动退回 http，不会因为选了 ws 就发不出声。

let cfg = () => ({});
let log = () => {};
let apiFetch = null;

// ── 官方接口常量 ──────────────────────────────────────────────────────────
const DEFAULT_BASE = 'https://api.deepseek.com';
/** 整段/流式合成共用同一个路径，只是协议不同。 */
const TTS_PATH = '/v1/tools/tts';
/** 官方只有这两个音色，别的一律回落到 stella。 */
const VOICES = ['stella', 'tide'];
const VOICE_LABEL = { stella: '海星（女声）', tide: '暗潮（男声）' };
const FORMATS = ['wav', 'pcm'];
/** pcm 的固定参数（官方文档：24 kHz、16 位、单声道）。 */
const PCM = { sampleRate: 24000, channels: 1, bitDepth: 16 };
const DEFAULT_MAX_CHARS = 120;
const DEFAULT_TIMEOUT = 60000;

/**
 * 拼出 TTS 地址。允许设置里只写域名，也允许直接写全路径，
 * 免得有人把 https://api.deepseek.com/v1/tools/tts 粘进来后被拼成 …/tts/v1/tools/tts。
 */
export function ttsEndpoint(raw) {
  const b = (String(raw || '').trim() || DEFAULT_BASE).replace(/\/+$/, '');
  if (/\/tools\/tts$/i.test(b)) return b;
  if (/\/tools$/i.test(b)) return `${b}/tts`;
  if (/\/v\d+(?:\.\d+)?$/i.test(b)) return `${b}/tools/tts`;
  return `${b}${TTS_PATH}`;
}

/** 同一条路径的 WebSocket 版本：https→wss、http→ws。 */
export function wsEndpoint(raw) {
  return ttsEndpoint(raw).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/** 音色白名单校验：模型可能把「海星」「stella女声」之类塞进来。 */
export function normalizeVoice(value) {
  const v = String(value || '').trim().toLowerCase();
  if (VOICES.includes(v)) return v;
  if (/海星|stella|女/.test(v)) return 'stella';
  if (/暗潮|tide|男/.test(v)) return 'tide';
  return '';
}

/**
 * 配置清洗。纯函数，方便自检与回归。
 * @param {object} raw 技能设置
 */
export function readConfig(raw, deps = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const apiKey = String(c.apiKey || '').trim();
  const endpoint = ttsEndpoint(c.baseUrl);

  const voiceId = normalizeVoice(c.voiceId || c.voice) || 'stella';

  const formatRaw = String(c.format || c.audioFormat || '').trim().toLowerCase();
  const format = FORMATS.includes(formatRaw) ? formatRaw : 'wav';

  const transportRaw = String(c.transport || '').trim().toLowerCase();
  const transport = ['ws', 'websocket', 'stream'].includes(transportRaw) ? 'ws' : 'http';

  const maxCharsRaw = Math.floor(Number(c.maxChars));
  const maxChars = Math.min(2000, Math.max(20, Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? maxCharsRaw : DEFAULT_MAX_CHARS));

  const timeoutRaw = Math.floor(Number(c.timeoutMs));
  const timeoutMs = Math.min(300000, Math.max(5000, Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT));

  return {
    apiKey,
    baseUrl: endpoint,
    voiceId,
    format,
    transport,
    filterMarkdown: c.filterMarkdown !== false,
    maxChars,
    alsoSendText: c.alsoSendText === true,
    timeoutMs
  };
}

/**
 * 把模型给的 text 洗成「适合念出来」的样子。
 *
 * 为什么要洗：模型经常带 markdown（**加粗**、`代码`、列表符号）和表情符号，
 * 这些要么被逐字念出来（念成「星号星号」），要么让 TTS 停顿怪异；
 * 官方 filter_markdown 只去格式，不去 emoji，也不把换行变成停顿。
 * 换行合成一句：语音是一段连续音频，换行在 QQ 语音里没有意义。
 */
export function normalizeSpeakText(input) {
  let s = String(input ?? '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?```/g, ' ');              // 代码块整段丢掉（念不了）
  s = s.replace(/`([^`]*)`/g, '$1');                  // 行内代码保留内容
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');        // 图片
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');      // 链接保留文字
  s = s.replace(/https?:\/\/\S+/gi, '链接');           // 裸链接念出来很糟
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');           // 标题井号
  s = s.replace(/^\s{0,3}>\s?/gm, '');                // 引用
  s = s.replace(/^\s{0,3}(?:[-*+•]|\d+[.)、])\s+/gm, ''); // 列表符号
  s = s.replace(/~~([^~\n]+)~~/g, '$1');              // 删除线
  s = s.replace(/(\*\*|__)([^\n]+?)\1/g, '$2');       // 加粗
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1$2'); // 斜体
  s = s.replace(/[（(](?:笑|哭|小声|叹气|停顿|咳咳|无语|摊手|笑死|害羞|得意)[）)]/g, '');
  // 表情符号 / 变体选择符 / 零宽字符：官方不处理，念出来是噪音
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2190}-\u{21FF}]/gu, ' ');
  s = s.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
  s = s.replace(/[*_~#>|]/g, ' ');                    // 残留符号
  s = s.replace(/[\uFF5E\u301C]/g, ' ');              // 全角波浪线也念不出来
  s = s.replace(/\n+/g, '，');                        // 换行 → 逗号停顿（比连读自然）
  s = s.replace(/[ \t\u3000]+/g, ' ');
  s = s.replace(/[ \t]*([，、。！？；])[ \t]*/g, '$1'); // 标点两侧的空格（代码块留下的）
  s = s.replace(/，{2,}/g, '，');
  s = s.replace(/([。！？；])[，、]+/g, '$1');
  s = s.replace(/，([。！？；])/g, '$1');
  s = s.replace(/^[，、。；\s]+|[，、\s]+$/g, '');
  return s.trim();
}

/**
 * 计费字符：汉字算 2 个，其余（字母、数字、空格、标点）算 1 个。
 * 只用来在日志里估个价，官方以实际返回为准（这个接口不返回 usage）。
 */
export function billingChars(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    n += /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch) ? 2 : 1;
  }
  return n;
}

/** 裸 PCM 补 44 字节 WAV 头。QQ 端的 silk 转码只认有头的音频文件。 */
export function pcmToWav(pcm, opts = {}) {
  const bytes = Buffer.from(pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm));
  const sampleRate = opts.sampleRate || PCM.sampleRate;
  const channels = opts.channels || PCM.channels;
  const bitDepth = opts.bitDepth || PCM.bitDepth;
  const blockAlign = (channels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

/**
 * 验一段 WAV 是不是完整的。官方说「合成中途失败会直接断开响应」，
 * 这时候 HTTP 仍是 200、字节也有一堆，只有对照 RIFF 里的 data 长度才看得出来。
 * @returns {{ok:boolean, reason?:string, seconds?:number, bytes:number}}
 */
export function inspectWav(buf) {
  const b = Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  if (b.length < 44) return { ok: false, bytes: b.length, reason: `音频只有 ${b.length} 字节，不可能是一段 WAV` };
  if (b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WAVE') {
    return { ok: false, bytes: b.length, reason: '拿到的不是 WAV（缺 RIFF/WAVE 头）' };
  }

  let off = 12;
  let fmt = null;
  let dataSize = null;
  let dataBytes = 0;
  while (off + 8 <= b.length) {
    const id = b.subarray(off, off + 4).toString('latin1');
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= b.length) {
      fmt = {
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      dataSize = size;
      dataBytes = Math.max(0, b.length - body);
      break;
    }
    off = body + size + (size % 2);
  }

  if (dataSize === null) return { ok: false, bytes: b.length, reason: 'WAV 里找不到 data 段' };
  if (!dataBytes) return { ok: false, bytes: b.length, reason: 'WAV 的 data 段是空的（什么都没合成出来）' };

  // 流式响应常把 data 长度写成 0 或 0xFFFFFFFF（未知），这两种不当截断处理
  const unknown = dataSize === 0 || dataSize === 0xffffffff;
  if (!unknown && dataBytes < dataSize) {
    return {
      ok: false,
      bytes: b.length,
      reason: `合成中途断开：声明 ${dataSize} 字节，实际只收到 ${dataBytes} 字节`
    };
  }

  const rate = fmt ? fmt.sampleRate * (fmt.channels || 1) * ((fmt.bits || 16) / 8) : PCM.sampleRate * 2;
  const seconds = rate > 0 ? Math.min(dataBytes, unknown ? dataBytes : dataSize) / rate : 0;
  return { ok: true, bytes: b.length, seconds, dataBytes: Math.min(dataBytes, unknown ? dataBytes : dataSize) };
}

/** 响应体压成一行短摘要（别把整页 HTML 灌进日志）。 */
function snippet(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 从错误响应体里捞一句人话。官方/中转的错误体形状不完全一致。 */
export function errorDetail(body) {
  const text = Buffer.from(body instanceof Uint8Array ? body : Buffer.from(String(body ?? ''))).toString('utf8').trim();
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const e = j?.error ?? j;
    const msg = typeof e === 'string' ? e : (e?.message || e?.msg || j?.message || j?.detail || '');
    if (msg) return snippet(msg, 300);
    return snippet(JSON.stringify(j), 200);
  } catch {
    return snippet(text, 200);
  }
}

/** HTTP 状态码 → 能直接照做的提示。 */
export function httpHint(status) {
  if (status === 400) return '（文本为空，或没通过内容审核 Content Exists Risk：换一种说法，别念敏感词；如果原文几乎都是符号/表情，洗完之后也会变成空文本）';
  if (status === 401 || status === 403) return '（API Key 不对或没权限：确认是 platform.deepseek.com 建的 sk- Key，粘进去时没带空格/换行）';
  if (status === 404) return '（接口地址不对：默认应为 https://api.deepseek.com，插件自己拼 /v1/tools/tts；走中转时确认它支持 tools/tts）';
  if (status === 408 || status === 504) return '（合成超时：这条太长或服务繁忙，拆短一点再试）';
  if (status === 429) return '（并发超过 50 或触发限流：同一时间合成太多条了，稍等再试；也可能是余额不足）';
  if (status === 503) return '（服务繁忙，稍后自己会好）';
  if (status >= 500) return '（DeepSeek 服务端异常，稍后自己会好）';
  return '';
}

/** WebSocket 的 finish 错误码 → 人话。 */
function wsCodeHint(code, message) {
  const base = String(message || '').trim();
  const hint = {
    invalid_input: '（送进去的文本不合法或为空）',
    content_filter: '（文本没通过内容审核：换一种说法）',
    input_timeout: '（60 秒内没收到文字，会话被服务端关了）',
    service_error: '（服务端合成失败，稍后重试）'
  }[String(code || '')] || '';
  return `流式合成以 ${code || '未知错误'} 结束${hint}${base ? `：${snippet(base, 200)}` : ''}`;
}

/** AbortSignal 超时抛出来的错太含糊，补一句人话。 */
function timeoutError(c, error) {
  const name = String(error?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`合成超时（${c.timeoutMs}ms）：把「单条合成超时」调大，或把句子拆短再试`);
  }
  return null;
}

async function postJsonAudio(c, spoken, doFetch) {
  const payload = {
    text: spoken,
    voice_id: c.voiceId,
    format: c.format,
    filter_markdown: c.filterMarkdown
  };

  let res;
  try {
    res = await doFetch(c.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'audio/wav, audio/pcm, application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(c.timeoutMs)
    });
  } catch (error) {
    throw timeoutError(c, error) || new Error(`连不上 TTS 接口（${c.baseUrl}）：${error?.message ?? error}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  return { res, bytes };
}

/** 走官方整段合成：POST /v1/tools/tts，响应体就是音频。 */
export async function synthesizeHttp(c, spoken, doFetch) {
  const { res, bytes } = await postJsonAudio(c, spoken, doFetch);
  const ctype = String(res.headers?.get?.('content-type') || '');

  if (!res.ok) {
    throw new Error(`DeepSeek TTS 返回 HTTP ${res.status}${httpHint(res.status)}${bytes.length ? `：${errorDetail(bytes)}` : ''}`);
  }
  // 万一中转把音频包成了 JSON（成功体或错误体都见过），早点说清楚
  if (/application\/json/i.test(ctype)) {
    throw new Error(`接口返回的是 JSON 而不是音频：${errorDetail(bytes)}（检查「接口地址」是不是中转，以及它是否真的转发 tools/tts）`);
  }
  if (!bytes.length) throw new Error('接口返回了 200，但音频是空的（合成可能没真正开始）');

  // pcm 是裸数据，必须先补 WAV 头，否则协议端认不出这是音频
  const audio = c.format === 'pcm' ? pcmToWav(bytes) : bytes;
  const info = inspectWav(audio);
  if (!info.ok) throw new Error(`音频不完整：${info.reason}。这通常是合成中途断了，原样重试一次往往就好`);

  return {
    audioBuf: audio,
    bytes: audio.length,
    seconds: info.seconds || 0,
    transport: 'http',
    format: 'wav'
  };
}

/** 取一个可用的 WebSocket 实现（Node 22+ 自带全局 WebSocket）。 */
function resolveWebSocket() {
  const impl = globalThis.WebSocket;
  return typeof impl === 'function' ? impl : null;
}

/**
 * 走官方流式合成：
 *   wss://api.deepseek.com/v1/tools/tts?voice_id=stella&format=pcm&filter_markdown=true
 *   子协议 ['tts', 'bearer.<key>']（WebSocket 传不了 Authorization 头，官方给了这个口子）
 *   发 text 帧 → finish_text → 收二进制 → 收 {"event":"finish"} 判断成功
 * 流式只拿 pcm：opus 是不带容器的数据包，存不成文件，也就发不了 QQ。
 */
export function synthesizeWs(c, spoken, WSImpl, deps = {}) {
  const Impl = WSImpl || resolveWebSocket();
  if (typeof Impl !== 'function') {
    const error = new Error('当前运行环境没有 WebSocket（需要 Node 22+ 的全局 WebSocket）：把「合成方式」改回 http 即可');
    error.code = 'no_websocket';
    throw error;
  }

  const query = new URLSearchParams({
    voice_id: c.voiceId,
    format: 'pcm',
    filter_markdown: String(c.filterMarkdown)
  });
  const url = `${wsEndpoint(c.baseUrl)}?${query.toString()}`;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let ws = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* 已经关了就算了 */ }
      if (error) reject(error); else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`流式合成超时（${c.timeoutMs}ms）：收音频收到一半没动静了`)), c.timeoutMs);

    try {
      ws = new Impl(url, ['tts', `bearer.${c.apiKey}`]);
    } catch (error) {
      finish(error);
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ event: 'text', text: spoken }));
        ws.send(JSON.stringify({ event: 'finish_text' }));
      } catch (error) {
        finish(error);
      }
    };

    ws.onmessage = (event) => {
      const data = event?.data;
      if (typeof data === 'string') {
        let msg = null;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg?.event === 'finish') {
          if (msg.code === 'success') {
            finish(null, chunks);
          } else {
            const error = new Error(wsCodeHint(msg.code, msg.message));
            error.code = String(msg.code || 'ws_failure');
            finish(error);
          }
        }
        return;
      }
      if (data) chunks.push(Buffer.from(data));
    };

    ws.onerror = (event) => {
      const detail = event?.message || event?.error?.message || '';
      const error = new Error(`WebSocket 连接失败${detail ? `：${detail}` : '（地址、鉴权或网络问题）'}`);
      error.code = 'ws_error';
      finish(error);
    };

    ws.onclose = (event) => {
      const error = new Error(`WebSocket 在收到 finish 之前就关了${event?.code ? `（code=${event.code}）` : ''}`);
      error.code = 'ws_closed';
      finish(error);
    };

    // 自检时方便观察有没有按时发 finish_text
    if (typeof deps.onOpen === 'function') deps.onOpen(ws);
  }).then((parts) => {
    const pcm = Buffer.concat(parts);
    if (!pcm.length) throw new Error('流式合成结束了，但一帧音频都没收到');
    if (pcm.length % 2 !== 0) throw new Error(`流式合成收到的 PCM 字节数不是偶数（${pcm.length}），数据可能被截断`);
    const audio = pcmToWav(pcm);
    const info = inspectWav(audio);
    return {
      audioBuf: audio,
      bytes: audio.length,
      seconds: info.seconds || 0,
      transport: 'ws',
      format: 'wav'
    };
  });
}

/** 流式错误里，只有内容层面的问题不该退回 http（退回也一样会被拒）。 */
function isFatalWs(error) {
  return ['content_filter', 'invalid_input', 'no_websocket'].includes(String(error?.code || ''));
}

/**
 * 合成一段语音。返回 { audioB64, spoken, format, bytes, seconds, billing, transport }。
 * @param {object} args { text, voice }
 * @param {object} deps { fetchImpl, wsImpl, cfg }（自检时注入假 fetch / 假 WebSocket）
 */
export async function synthesize({ text, voice } = {}, deps = {}) {
  const c = readConfig(deps.cfg || cfg());
  if (!c.apiKey) throw new Error('还没填 DeepSeek API Key（技能设置 → API Key，sk- 开头）');

  const spoken = normalizeSpeakText(text);
  if (!spoken) throw new Error('要说的内容是空的（去掉表情/markdown 之后什么都没剩下）');
  if (spoken.length > c.maxChars) {
    throw new Error(`这句话太长（${spoken.length} 字，上限 ${c.maxChars} 字）。`
      + '把内容拆成几条短句分别调用，或者改用打字回复——QQ 语音太长会被拒收，念出来也像念稿。');
  }

  const doFetch = deps.fetchImpl || apiFetch;
  if (typeof doFetch !== 'function') throw new Error('缺少 fetch（清单里需要声明 web_fetch 权限）');

  const override = normalizeVoice(voice);
  const conf = override ? { ...c, voiceId: override } : c;

  let result;
  let fellBack = false;
  if (conf.transport === 'ws') {
    try {
      result = await synthesizeWs(conf, spoken, deps.wsImpl);
    } catch (error) {
      if (isFatalWs(error) || error?.code === 'ws_failure') throw error;
      log(`流式合成没成功，改用整段合成重试一次：${error?.message ?? error}`);
      result = await synthesizeHttp(conf, spoken, doFetch);
      fellBack = true;
    }
  } else {
    result = await synthesizeHttp(conf, spoken, doFetch);
  }

  const billing = billingChars(spoken);
  log(`语音合成完成（${result.transport === 'ws' ? 'WebSocket 流式' : '整段'} / ${conf.voiceId} ${VOICE_LABEL[conf.voiceId]}）：`
    + `${spoken.length} 字，${result.bytes} 字节，约 ${result.seconds.toFixed(1)} 秒，`
    + `计费约 ${billing} 字符（≈ ${(billing * 3 / 20000).toFixed(4)} 元）`
    + `${fellBack ? '，流式失败已回落 http' : ''}`);

  return {
    audioB64: result.audioBuf.toString('base64'),
    spoken,
    format: 'wav',
    bytes: result.bytes,
    seconds: result.seconds,
    billing,
    transport: result.transport,
    fellBack
  };
}

// ── 技能生命周期 ──────────────────────────────────────────────────────────

/** 短指纹：给发送队列做去重键，避免同一句话在去重窗口内被念两遍。 */
function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  apiFetch = api.fetch;

  api.registerTool({
    id: 'say',
    name: '用语音说话',
    category: 'media',
    icon: '🔊',
    description: '把一句话用你自己的声音说出来，发成一条真正的QQ语音消息（不是文字）。只在用户明确要你用语音（用语音回我/说句话/念一下/唱一段），或语音明显比文字更合适时用。一次只适合一两句短话；发完不要再把同一句话用文字发一遍。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: '要说出口的话。会被逐字念出来，所以别写表情符号、markdown、括号里的动作描写；一两句、60 字内最好。'
        },
        voice: {
          type: 'string',
          enum: ['stella', 'tide'],
          description: '可选：这一句用哪个音色，stella 女声（默认）/ tide 男声。不填就用技能设置里的音色。'
        },
        replyToMessageId: {
          type: ['integer', 'string'],
          description: '可选：要引用/回复的消息 id（聊天记录里每条消息前的 #数字）'
        }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        if (!ctx?.chatKey) return { content: '错误：当前环境没有会话上下文，无法发语音', isError: true };
        if (typeof ctx.sender?.sendMedia !== 'function') {
          return { content: '错误：当前环境缺少发送接口（sender.sendMedia），语音没发出去', isError: true };
        }

        const { audioB64, spoken } = await synthesize({ text: args?.text, voice: args?.voice });

        // 走公共发送入口：不绕过限频与留档。record 段的 silk 转码由协议端负责（wav 它能吃）。
        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: `base64://${audioB64}` } }], {
          label: `[语音]${spoken.slice(0, 30)}`,
          dedupeKey: `tts:${fingerprint(spoken)}`,
          replyToMessageId: args?.replyToMessageId ?? null
        });

        if (readConfig(cfg()).alsoSendText) {
          try { await ctx.sender.sendTextBatch(ctx.chatKey, [spoken], {}); }
          catch (error) { log(`语音已发出，但补发的文字失败：${error?.message ?? error}`); }
        }

        // 会话页留痕（与内置发图/发表情工具同一口径）；失败不影响主流程
        try {
          ctx.session?.sent?.push({
            type: 'voice',
            text: `[语音]${spoken.slice(0, 40)}`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 留痕失败不影响这条语音已经发出去的事实 */ }

        return {
          content: `已用语音说出：「${spoken}」。这条语音已经直接发到会话里了——不要再把同一句话用文字发一遍，也不要向用户汇报"已发送"。`
        };
      } catch (error) {
        const msg = String(error?.message ?? error);
        log(`语音说话失败：${msg}`);
        return { content: `语音发送失败：${msg}。可以改用文字回复，不要立刻重复调用本工具。`, isError: true };
      }
    }
  });

  const now = readConfig(cfg());
  log(`语音说话（DeepSeek 官方 TTS）已注册：${now.voiceId} ${VOICE_LABEL[now.voiceId]}，`
    + `${now.transport === 'ws' ? 'WebSocket 流式' : '整段 http'}，格式 ${now.format}，`
    + `地址 ${now.baseUrl}${now.apiKey ? '' : '；⚠️ 还没填 API Key，发语音会失败'}`);
}

/**
 * 自检：必须同步返回（返回 Promise 会被当成"可用"），所以只做配置校验，不发网络请求。
 */
export function available() {
  let c;
  try { c = readConfig(cfg()); } catch (error) { return { ok: false, reason: `配置读不出来：${error?.message ?? error}` }; }
  if (!c.apiKey) return { ok: false, reason: '还没填 DeepSeek API Key（设置里的「DeepSeek API Key」，sk- 开头）' };
  if (!/^https?:\/\//i.test(c.baseUrl)) return { ok: false, reason: `接口地址要以 http(s):// 开头（当前：${c.baseUrl}）` };
  if (!c.baseUrl.includes('/tools/tts')) return { ok: false, reason: `接口地址解析后是 ${c.baseUrl}，不像一个 TTS 端点` };
  if (!VOICES.includes(c.voiceId)) return { ok: false, reason: `音色只能是 ${VOICES.join(' / ')}` };
  return { ok: true };
}

export const internals = {
  synthesize,
  synthesizeHttp,
  synthesizeWs,
  readConfig,
  normalizeSpeakText,
  normalizeVoice,
  billingChars,
  pcmToWav,
  inspectWav,
  ttsEndpoint,
  wsEndpoint,
  errorDetail,
  httpHint,
  fingerprint
};
