# BiliNote Design System v2 —「高级感 · 年轻审美」

## Product context

BiliNote 是 Chrome/Edge 扩展：B站视频学习时，AI 生成课程大纲/分段总结/难点讲解，沉淀笔记同步 Notion。核心界面是 **Side Panel（400px 基准宽度）**，用户余光扫读——可扫读性第一，同时要有「打开就觉得很贵」的质感。

## Visual direction

「深夜自习室的台灯」：**深色主题为主战场**（年轻用户主流），浅色同样精致。高级感来自四个克制的手段：

1. **深邃的分层底色**（不是纯黑，是带蓝调的深空色）
2. **唯一的高光**：品牌渐变只出现在 4 个地方——主按钮、logo、进度条、激活 tab 指示条，除此之外全界面无渐变
3. **材质感**：玻璃拟态顶栏（backdrop-blur）、卡片发丝边 + 顶部 1px 内高光、柔和多层投影
4. **节奏感**：8px 网格严格对齐、标题 tracking-tight、数字 tabular-nums、Lucide 图标统一 optical size

DON'T：大面积渐变背景、彩虹多色、emoji 当图标、厚重投影、圆角混乱、超过 2 级字重跳跃。

## Color tokens

### Brand（双节点渐变色系，单色使用时取 brand-600）

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `brand-600` | `#4F46E5` | — | 主按钮底、强调文本（仅 light 文本场景） |
| `brand-500` | `#6366F1` | `#6366F1` | 渐变起点、icon 强调 |
| `violet-500` | `#8B5CF6` | `#8B5CF6` | 渐变终点 |
| `brand-300` | `#A5B4FC` | `#A5B4FC` | dark 主题强调文本/图标 |
| `brand-gradient` | `linear-gradient(135deg,#6366F1,#8B5CF6)` | 同左 | **仅**：主 CTA、logo、进度条、tab 指示条 |
| `brand-soft` | `#EEF2FF` | `rgba(99,102,241,0.14)` | pill/badge 底、hover 行底 |
| `brand-ring` | `rgba(99,102,241,0.25)` | `rgba(99,102,241,0.35)` | focus ring、激活描边 |

### Surfaces（slate 冷灰家族，dark 带蓝调）

| Token | Light | Dark |
|---|---|---|
| `page` | `#F7F8FA` | `#0B0E14` |
| `surface` | `#FFFFFF` | `#12161F` |
| `surface-2`（hover/嵌套） | `#F1F3F7` | `#1B2130` |
| `border` | `rgba(15,23,42,0.07)` | `rgba(255,255,255,0.06)` |
| `border-strong` | `rgba(15,23,42,0.12)` | `rgba(255,255,255,0.10)` |
| `text` | `#0F172A` | `#E2E8F0` |
| `text-secondary` | `#64748B` | `#94A3B8` |
| `text-faint` | `#94A3B8` | `#5B6474` |

### Status（低饱和）

success `#10B981` / warning `#F59E0B` / danger `#EF4444` / info `#38BDF8`；soft 底 = 12% 透明度同色。

### Elevation

- Light 卡片：`0 1px 2px rgba(15,23,42,.04), 0 8px 24px -12px rgba(15,23,42,.10)`
- Dark 卡片：1px `border` + `inset 0 1px 0 rgba(255,255,255,0.04)`（顶部内高光），无投影
- 可点击卡片 hover：`translateY(-1px)` + 阴影加深/边框提亮，`150ms ease-out`

## Typography

- Family：`-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`；mono：`"JetBrains Mono", ui-monospace, Menlo, monospace`（时间戳、token 数、baseURL）
- 所有数字：`font-variant-numeric: tabular-nums`
- Scale：11px（badge）/ 12px（元信息）/ 13px（正文）/ 15px（卡片标题，tracking -0.01em）/ 17px（页面标题，tracking -0.02em）
- Weight：正文 400 / 标题 500-600 / wordmark 600；标题不超重

## Spacing / Radius

- 8px 网格：4/8/12/16/24；卡片 p-4（hero 卡可 p-5）；section 间距 16/32
- Radius：控件 8px、卡片 14px、pill 999px、logo 6px、缩略图 10px

## Motion

- `150–250ms cubic-bezier(0.4,0,0.2,1)`；按钮 active `scale(0.98)`；卡片入场 fade+translateY(6px) 60ms 级联；tab 切换指示条滑动 200ms；不用弹簧/粒子

## Icons —— 只用 Lucide（lucide.nodejs.cn 同名）

- inline SVG，stroke `currentColor`，**strokeWidth 1.75**，round cap/join；尺寸 14（按钮内）/ 16（常规）/ 18（空状态 40px 可用 1.5）
- 语义映射：一键分析 `sparkles`、播放/视频 `play`、设置 `settings`、课程大纲 `list-tree`、分段总结 `file-text`、重点难点 `zap`、重新生成 `refresh-cw`、取消 `x`、完成 `check`、时间 `clock`、笔记 `notebook-pen`、学习 `graduation-cap`、同步 `cloud-upload`/「已同步」`cloud-check`、警告 `triangle-alert`、错误 `octagon-x`、跳转 `arrow-right`、封面占位 `clapperboard`
- 禁止 emoji 图标；图标颜色跟随 text-secondary，强调场景用 brand-300/500

## Component specs

- **Logo**：使用品牌资产 `public/logo-tile.png`（紫色圆角方块 + 白色学士帽笔记图标，透明角）；扩展图标 `public/icon/{16,32,48,128}.png`；界面内 20px 圆角 6px 展示（side panel / options 顶栏）+ 「BiliNote」15px 600 tracking-tight。**禁止**回退为渐变 tile + Lucide 图标的旧方案
- **Primary CTA**：brand-gradient 底、白字、8px 圆角、40px 高、`shadow: 0 4px 14px -4px rgba(99,102,241,.5)`、左 sparkles 14px 图标；hover 亮度 +4%；active scale(.98)
- **Ghost button**：1px border-strong、透明底、36px、hover 边框/文字转 brand-500
- **视频 hero 卡**：surface + 14px 圆角；左侧 96×60 缩略图（渐变底 + 白色 play 图标占位，实拍封面 object-cover）；标题 15px/500 两行截断；meta 12px secondary（UP 主 · 分P · 时长，间隔点 `·` 用 text-faint）
- **时间戳 pill**：brand-soft 底 + brand-500 字（dark 用 brand-300）、mono 11px、tabular-nums、rounded-full px-2 py-[3px]；hover 底变 brand-ring；**所有可跳转时间点统一此样式**
- **结果卡**：标题行 = 16px Lucide 图标（brand-500）+ 15px/500 标题 + 右侧元信息；大纲条目 = mono 序号（text-faint, 02 位）+ 时间戳 pill + 标题，行高 36px，hover 行底 brand-soft
- **进度条**：4px rounded-full、surface-2 底、brand-gradient 填充、宽度=真实进度；配 12px secondary 步骤文本
- **Badge**：11px、rounded-full、soft 底 + status 字（缓存/同步状态/AI 字幕）
- **Input**：36px、8px 圆角、1px border-strong、surface 底；focus：border brand-500 + 3px brand-ring 外发光；password 用 mono
- **Tab 切换**：text-secondary，激活 = text + 底部 2px brand-gradient 指示条滑动
- **Empty state**：40px Lucide（text-faint）+ 15px/500 主文案 + 12px secondary 辅助 + ghost 按钮
- **Header**：sticky、glass（`backdrop-blur(12px)` + page 色 75% 透明）+ 底发丝边；左 logo，右 16px settings 图标按钮（ghost，圆形 hover 底 surface-2）
