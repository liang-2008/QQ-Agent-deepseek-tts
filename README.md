# 语音说话 · DeepSeek 官方 TTS（deepseek-tts）

给 **QQ Agent / SnowLuma** 用的技能：让机器人把一句话合成真正的 **QQ 语音消息**，而不是打字。

> 当前版本：**1.0.0** · Skill API：**v1** · 默认不启用
>
> 技能 ID：`deepseek-tts` → 工具名 `deepseek-tts__say`
>
> 后端只有一条：**DeepSeek 官方语音合成**（`api.deepseek.com/v1/tools/tts`）。不需要另开通 TTS 服务，聊天用的那把 `sk-` Key 直接就能用。

## 三句话版本

- 装上 → 技能页打开开关 → 设置里粘一把 DeepSeek API Key，就能发语音。
- 音色只有两个：`stella`（海星，女声，默认）、`tide`（暗潮，男声）。
- 没有语速、情绪、方言参数——想让声音对味，只能改**措辞**（见下面「怎么让她听起来不像念稿」）。

---

## 为什么又写了一个

上一个版本（`mimo-tts`）是三条通道拼起来的：阿里云百炼、小米 MiMo、自建 Qwen3-TTS-Lunar，每条通道的音色逻辑、鉴权方式、返回格式都不一样，代码里大量分支都是为了兼容它们。

现在 DeepSeek 官方直接出了语音合成，一把 Key、一个端点、两种格式，于是干脆重写成一个单通道的技能：

| | mimo-tts（旧） | deepseek-tts（本仓库） |
| --- | --- | --- |
| 后端 | 百炼 / 小米 / 本地，三选一 | 只用 DeepSeek 官方 |
| 鉴权 | `sk-` / `tp-` / 无（本地） | 只有 Bearer `sk-` |
| 音色 | 固定 ID / 文字描述 / 参考音频 | 两个固定 ID |
| 返回 | JSON + 音频 URL / base64 / WAV 二进制 | **响应体直接就是音频字节** |
| 格式 | mp3 / wav | wav / pcm（没有 mp3） |
| 情绪控制 | 百炼有 `instruction` 字段 | 没有，只能改措辞 |
| 配置文件 | 有 `voice.txt` 写音色描述 | 删掉了，没有意义 |

保留了旧版本里被验证过的部分：工具注册方式、`sendMedia` 发 `record` 段、文本清洗、字数上限、去重键、会话留痕、明确的错误提示。

---

## 官方接口长什么样

### 音色

| `voice_id` | 音色 |
| --- | --- |
| `stella` | 海星，女声，默认 |
| `tide` | 暗潮，男声 |

没有别的音色，也没有克隆。**语种不用选**：普通话、粤语、英语、日语、韩语、马来语、阿拉伯语、印尼语、泰语、越南语都按文本自动识别。

### 整段合成（默认，`transport = http`）

```http
POST https://api.deepseek.com/v1/tools/tts
Authorization: Bearer sk-...
Content-Type: application/json

{"text": "你好，我是 DeepSeek。", "voice_id": "stella", "format": "wav", "filter_markdown": true}
```

响应体**直接是音频**（`audio/wav`），不是 JSON，边合成边返回。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 最多 1 万计费字符，请求体最大 64 KiB |
| `voice_id` | 否 | `stella`（默认）/ `tide` |
| `format` | 否 | `wav`（默认）/ `pcm` |
| `filter_markdown` | 否 | 朗读前去掉 Markdown，默认 `true` |

`pcm` 是 **24 kHz / 16 位 / 单声道** 的裸数据：**没有文件头**。本插件会自动补 44 字节 WAV 头再发，因为 QQ 的 silk 转码要一个完整音频文件。

### 流式合成（`transport = ws`）

```text
wss://api.deepseek.com/v1/tools/tts?voice_id=stella&format=pcm&filter_markdown=true
Sec-WebSocket-Protocol: tts, bearer.sk-...
```

1. 连上后发 `{"event":"text","text":"…"}`，最后发 `{"event":"finish_text"}`
2. 音频以二进制帧下发（`pcm`，或 `opus`——opus 是不带容器的数据包，存不成文件，本插件不用）
3. 会话以 `{"event":"finish","code":"success|invalid_input|content_filter|input_timeout|service_error","message":"…"}` 结束

WebSocket 传不了自定义请求头，所以官方给了子协议这条路，插件用的就是 `['tts', 'bearer.<API Key>']`。

**为什么默认不是流式**：QQ 语音要的是一个完整文件，不是边播边收；http 一次拿全最简单，也少一层 Node 版本依赖（全局 `WebSocket` 要 Node 22+）。选了 `ws` 而环境不支持、或连接失败时，插件会自动退回 http 一次，不会因为选错方式就发不出声。

### 状态码

| 状态码 | 原因 | 插件怎么处理 |
| --- | --- | --- |
| `400` | 没有可朗读的文本，或没过内容审核（`Content Exists Risk`） | 把服务端原文带进报错，提示换说法 |
| `401` / `403` | Key 不对 | 提示检查 Key 与空格 |
| `429` | 账号并发超过 50 | 提示稍等、检查余额 |
| `503` / `504` | 服务繁忙 / 合成超时 | 提示稍后重试、拆短句 |
| 2xx 但中途断开 | 音频已开始返回后失败 | **校验 WAV 的 data 长度**，短了直接判失败，不发半截音频 |

---

## 功能

- 注册工具 `deepseek-tts__say`，由模型自己判断什么时候该用语音
- 支持群聊 / 私聊，发的是真正的 QQ 语音气泡，不是文字
- 整段（HTTP）/ 流式（WebSocket）两种合成方式，流式失败自动回落
- 裸 PCM 自动补 WAV 头；收完音频会验 RIFF / data 长度，截断的不发
- 文本先清洗：代码块、Markdown、表情符号、链接、列表符号、换行、动作括号
- 单条语音有字数上限，超了直接拒绝并让模型拆短句
- 语音之外可选再补一条文字
- 发送走 `ctx.sender.sendMedia()`，不绕过发送队列、限频和留档
- 同一条内容有去重键，避免短时间重复念
- 日志里报字节数、时长、估算费用

---

## 安装

把整个目录放进 QQ Agent 的 `skills/`，目录名建议用 `deepseek-tts`（和技能 ID 一致）：

```text
<QQ Agent>/skills/deepseek-tts/
  skill.json
  index.js
  package.json
  README.md
  LICENSE
  tools/live-check.mjs     ← 真机试听用，插件运行不需要
  tests/smoke.mjs          ← 自检用，插件运行不需要
```

然后在 QQ Agent 的技能页里：

1. 找到「语音说话（DeepSeek 官方）」，打开开关
2. 打开设置 → 「DeepSeek API Key」填 `sk-` 开头的 Key
3. 保存后即时生效，不需要重启

`skill.json` 里声明了 `web_fetch` 权限；没有它插件拿不到 `fetch`，一条语音都发不出来。

> 只覆盖 `index.js` 不够：`skill.json` 里才有默认值、配置项和给模型的提示词，两个文件要一起更新。

---

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://api.deepseek.com` | 插件自动补成 `/v1/tools/tts`；填 `/v1`、`/v1/tools/tts` 也认。只有走自建中转时才需要改 |
| `apiKey` | 空 | `platform.deepseek.com` 建的 `sk-` Key，和聊天同一把 |
| `voiceId` | `stella` | `stella` 女声 / `tide` 男声 |
| `format` | `wav` | `wav` / `pcm`。**没有 mp3**；`pcm` 也会被补头成 WAV 再发 |
| `transport` | `http` | `http` 整段 / `ws` 流式（失败自动回落 http） |
| `filterMarkdown` | `true` | 让服务端先去掉 Markdown |
| `maxChars` | `120` | 单条字数上限（20–2000）。官方上限是 1 万计费字符，这里是为了聊天体验 |
| `alsoSendText` | `false` | 语音之后再补一条同样的文字 |
| `timeoutMs` | `60000` | 单条合成超时（5 秒–5 分钟） |

---

## 怎么让她听起来不像念稿

这个接口**没有**情绪、语速、方言、角色参数。同一句话，`stella` 永远是同一个 `stella`。所以「语气」只能从文本本身来：

- **短句**。一句一个意思，用逗号、句号断开，别写成一段书面语。
- **语气词**。「呀 / 啦 / 嘛 / 诶 / 哦 / 嗯」这类词对韵律的影响比任何参数都大。
- **标点当节奏**。省略号是拖长，破折号是停顿，问号会自然上扬。
- **别写动作描写**。「（撒娇地）」「[笑]」不会被演出来，要么念出来，要么被插件当噪音删掉。
- **数字和英文**要写成念得出来的样子：「3 点」比「03:00」自然，「OK」比「✅」自然（后者会被删掉）。
- 想换性别就换 `tide`，别指望 `stella` 变成男声。

这也是为什么旧版本那个 `voice.txt` 被删了：那里面的「幼态萝莉音、语速偏快」在百炼/小米那边是**造音色**的输入，在官方接口里无处可填——写了也不会生效，留着反而误导。

---

## 计费

| 计费单位 | 刊例价 | 限时折扣价（5 折） |
| --- | --- | --- |
| 每 10,000 字符 | 3 元 | 1.5 元 |

**汉字算 2 个字符**，英文字母、数字、空格等其他字符算 1 个。插件日志会按这个规则估一句大概多少钱，例如：

```text
语音合成完成（整段 / stella 海星（女声））：12 字，187 字节，约 3.1 秒，计费约 24 字符（≈ 0.0036 元）
```

聊天场景里一条语音通常 10–30 个字符，一天几十条也就几分钱。

---

## 自检

**离线自检**（不需要 Key、不联网，覆盖 61 项）：

```powershell
node tests/smoke.mjs     # 不用装任何依赖；也可以 npm test
```

覆盖：地址拼接、配置夹取、文本清洗、计费字符、PCM 补头、WAV 截断检测、整段合成的成功/400/空音频/JSON 错误体、流式合成的成功/内容审核/断线回落、字数上限、`available()`、`registerTool` 参数表、`execute` 走 `sendMedia`。

**真机试听**（真的要花几分钱）：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
node tools/live-check.mjs "你好呀，今天也要早点睡哦。"
```

默认写 `out.wav` 并自动打开播放器。加 `--voice tide` 换男声，`--ws` 试流式，`--pcm` 试裸 PCM 那条路。

---

## 已知限制

- **没有 mp3**。官方只给 `wav` / `pcm`；`pcm` 是裸数据，插件会补 WAV 头，所以最终发出去的永远是 WAV（体积比 mp3 大，一条 5 秒语音约 240 KB）。
- **没有情绪 / 语速 / 方言参数**，音色只有两个，也没有克隆。
- **不能中断后续传**，不支持调语速；语音写多长就念多长。
- **音频中途断开不会报错码**：官方文档明确说这种情况下响应会直接断，插件靠校验 WAV 长度兜住，判失败后原样重试一次通常就好。
- **并发 50**：同一账号同时超过 50 个请求返回 `429`，机器人这边一般不会碰到。
- **语音气泡能不能播**取决于协议端的 silk 转码（`loadPtt → encodeSilk`）；插件只保证交给它的是一个合法的 WAV。如果日志显示「已发出」但群里没声音，先看协议端日志里的 ffmpeg 报错。
- 官方接口**不返回 usage**，插件日志里的费用是按字符估算的。

---

## 常见问题

**400，提示 `Content Exists Risk`**
文本没通过内容审核。换一种说法；如果原文几乎全是符号或表情，洗完之后会变成空文本，也会 400。

**400，但文本看起来很正常**
检查是不是 `filter_markdown` 把整句都当格式删了（比如整句被 `**` 包住），或者文本里有大量特殊符号。

**发送失败：`音频不完整`**
合成中途断了。原样重试一次；连续出现就检查网络、把 `timeoutMs` 调大，或换 `transport = ws` 试试。

**发送失败：`当前运行环境没有 WebSocket`**
Node 版本低于 22，而 `transport` 选了 `ws`。改回 `http` 即可。

**机器人一直不说话**
按顺序查：技能开关 → `apiKey` 是否填对 → 技能页的「自检」有没有报错 → 日志里有没有 `语音说话失败`。另外模型只在它觉得该说话的时候才调工具，可以直接跟它说「用语音说一句晚安」。

**改完 `skill.json` 没变化**
设置页里的值一旦保存就会覆盖默认值，改默认值只对没保存过的配置生效。

---

## 更新日志

### 1.0.0

- 首个版本：单通道走 DeepSeek 官方 TTS（整段 + 流式）
- 裸 PCM 自动补 WAV 头；WAV 截断检测
- 流式失败自动回落整段合成
- 文本清洗（Markdown / 表情 / 链接 / 动作括号 / 换行转停顿）
- 字数上限、去重键、会话留痕、可选补发文字

---

## 致谢

- 接口文档：[DeepSeek API · 语音合成](https://api-docs.deepseek.com/zh-cn/guides/tts/)
- 上一代多通道版本：`mimo-tts`（百炼 / 小米 / 本地 Qwen3-TTS-Lunar），本仓库的工具注册、发送链路和文本清洗直接从它继承
- QQ Agent / SnowLuma：`ctx.sender.sendMedia`、`record` 段与 silk 转码由协议端负责

## 许可

MIT，见 [LICENSE](./LICENSE)。
