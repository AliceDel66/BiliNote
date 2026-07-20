# Routes — BiliNote

Browser extension (WXT). "Routes" are extension entrypoints, not URL routes.

| Entrypoint | HTML | 用途 | 主要文件 |
|---|---|---|---|
| Side Panel | `sidepanel.html` | 核心界面：当前视频卡、一键分析、流式进度、大纲/分段/重点结果渲染（规划中：笔记编辑） | `entrypoints/sidepanel/App.tsx` |
| Options | `options.html`（open_in_tab） | 模型 Profile CRUD、拉取模型列表、测试连接（规划中：Notion 集成、数据管理） | `entrypoints/options/App.tsx` |
| Content Script | —（注入 bilibili.com/video/*） | 页面识别、播放器 seek；无可见 UI | `entrypoints/content.ts` |
| Background SW | — | 消息路由、API 编排；无 UI | `entrypoints/background.ts` |

## Side Panel（主设计对象）

渲染状态机：`loading / no-video / ready / analyzing / done / no-subtitle / error`。

- `ready`：视频信息卡（标题 2 行截断、UP 主/分P/时长元信息）+ 全宽主按钮「一键分析」
- `analyzing`：进度文本（animate-pulse）+ 取消链接 + 流式原文 `<pre>` 滚动区
- `done`：缓存/ token 用量行 + 「课程大纲」卡（时间戳链接列表）+ 若干「分段总结」卡（标题 + 起止时间 + 要点 ul）+「重点/难点讲解」卡
- `no-subtitle`：琥珀色说明 + 重试；`error`：红色错误 + 重试/检查模型设置双按钮

## Options

单页两 section：已保存配置列表（radio 激活 + 脱敏信息 + 编辑/删除）、新增/编辑表单卡（名称/baseURL/API Key/默认模型 + datalist + 拉取/测试/保存按钮组）。
