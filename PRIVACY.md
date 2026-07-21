# BiliNote 隐私政策

生效日期：2026 年 7 月 21 日

BiliNote 是一个开源、Local-first、BYOK 的 Chrome 扩展。本政策说明 BiliNote 如何处理用户数据，以及数据在浏览器、Bilibili 和用户自行配置的第三方服务之间如何流动。

## 1. 单一用途

BiliNote 的单一用途是在 Bilibili 视频页面中，将用户可访问的字幕或用户主动转写所得文本整理为带时间戳的学习课程、视频问答和 Markdown 笔记。

## 2. 处理的数据

BiliNote 只为实现上述用途处理以下数据：

- **网站内容与资源**：当前 Bilibili 视频的视频 ID、分 P、封面、UP 主、字幕、弹幕、播放位置，以及用户主动启用语音转写时临时读取的当前分 P 音频或 MP4 媒体；
- **网络记录**：用户在 BiliNote 中打开或分析的 Bilibili 视频 URL 和标题，仅用于识别当前视频、恢复课程和展示本地学习记录；BiliNote 不读取或保存与该功能无关的浏览历史；
- **身份验证信息**：用户自行填写的模型、语音转写和知识库服务 API Key、Token、远程 MCP URL 或其他连接凭据；
- **个人通讯和用户生成内容**：用户输入的问题、课程分析结果、AI 回答、Markdown 笔记和同步目标；
- **配置与学习记录**：主题、模型选择、上下文偏好、数据边界开关、课程记录和本地学习统计。

BiliNote 不处理姓名、邮寄地址、电话号码、身份证号码、健康信息、财务信息或精确位置。项目源码不包含广告 SDK、遥测 SDK 或托管账号系统。

## 3. 本地存储

- 课程、字幕缓存、分析结果、问答、笔记和学习记录保存在浏览器的 IndexedDB；
- 模型、语音转写和知识库连接凭据保存在 `chrome.storage.local`，不会进入数据导出或 `chrome.storage.sync`；
- 主题、激活模型、上下文预算、分析与问答偏好及数据边界开关保存在 `chrome.storage.sync`，开启 Chrome 同步时可能由 Chrome 同步；
- `chrome.storage.local` 是浏览器 Profile 内的本地存储，不是加密保险箱或硬件密钥库；
- 音频或 MP4 字节只在一次语音转写任务的内存中暂存，不写入 IndexedDB；转写后的文字和时间段可按字幕缓存规则保存；
- 字幕缓存和转写文本的 24 小时期限是复用 TTL。过期记录不再作为有效缓存读取，但不保证在到期时立即物理删除。

用户可在扩展的数据管理界面导出业务数据，或在二次确认后清空 IndexedDB、`chrome.storage.local` 和 `chrome.storage.sync` 中的 BiliNote 数据。

## 4. 外部传输及触发条件

BiliNote 没有开发者托管的业务后端。只有在提供用户可见功能所必需且由用户操作触发时，数据才会从扩展直接发送到以下目的地：

| 目的地 | 发送内容 | 触发条件 |
| --- | --- | --- |
| Bilibili API、字幕 CDN 和媒体 CDN | 视频 ID、分 P、字幕请求；请求可能使用当前 Bilibili 登录状态。只有用户选择语音转写时才请求播放地址并临时下载当前分 P 音频或 MP4 | 打开受支持视频、分析或问答缺少字幕缓存，或用户主动转写 |
| 用户配置的 AI 模型服务 | 字幕、课程结构、受限笔记摘录、播放元信息和用户问题，具体取决于数据边界开关 | 用户主动分析或提问 |
| 用户配置的语音转写服务 | 当前分 P 音频或 MP4、所选模型；连接测试会发送本地生成的 1 秒静音 WAV | 用户主动转写或测试连接 |
| 用户配置的知识库或本地 Bridge | 课程/分 P 标题和 Markdown 笔记 | 用户手动同步，或在配置连接器后启用自动同步 |

第三方服务只在用户自行配置、授权并触发相应功能后接收数据。第三方如何保存、使用或删除这些数据，受其各自隐私政策和服务条款约束。用户应只连接可信服务。

## 5. 数据分享和有限使用

- BiliNote 不出售用户数据；
- BiliNote 不将用户数据用于广告、信用评估、贷款、画像或与扩展单一用途无关的目的；
- 除提供用户主动请求的 AI、转写或知识库同步功能外，BiliNote 不向第三方传输用户数据；
- 开发者没有托管服务器接收这些数据，也不会安排人工阅读用户内容；
- 对通过 Chrome API 获得的信息，BiliNote 的使用遵守 [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)，包括 Limited Use 要求。

## 6. 权限用途

- `storage`：保存本地配置、偏好、凭据和扩展数据；
- `sidePanel`：在视频页面旁提供持续的课程、问答和笔记界面；
- `scripting`：扩展安装或重载后，为已经打开的 Bilibili 视频页补注入包内 Content Script；
- `declarativeNetRequest`：仅为 `bilivideo.com` 媒体请求添加 Bilibili `Referer`，避免 CDN 防盗链返回 403；不拦截、屏蔽或重定向其他网络请求；
- Bilibili、`hdslb.com` 和 `bilivideo.com` 主机权限：读取视频信息、字幕和用户主动转写所需媒体；
- 可选主机权限：只在用户配置模型、语音转写或知识库连接器后，按实际 origin 请求授权。

## 7. 远程代码

BiliNote 不使用远程托管代码。所有 JavaScript 和 Wasm（如有）均包含在提交审核的扩展软件包内。扩展从 Bilibili 和用户配置服务获得的 JSON、文本、字幕、媒体及流式响应仅作为数据解析，不会通过 `eval`、外部 `<script>`、远程模块或其他方式作为代码执行。

## 8. 安全措施

- 非 loopback 的模型和语音转写地址必须使用 HTTPS；
- 语雀及远程 MCP 等连接器限制使用受支持的 HTTPS 地址，本机 Bridge 只监听 loopback；
- 凭据不会进入日志、业务数据导出或 Chrome 同步；
- AI 生成的 Markdown 在渲染前进行清洗；
- 字幕和笔记在 Prompt 中按不可信输入处理，以降低 prompt injection 风险。

任何互联网服务都无法保证绝对安全。用户应妥善保护 API Key，并及时撤销已泄露的凭据。

## 9. 政策更新与联系

功能或数据处理方式发生变化时，本政策会随项目更新，并修改生效日期。问题、数据处理请求或安全报告可通过 [BiliNote GitHub Issues](https://github.com/AliceDel66/BiliNote/issues) 联系项目维护者；涉及敏感信息时，请勿在公开 Issue 中粘贴 API Key、Token、私有 URL 或个人内容。
