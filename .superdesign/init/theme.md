# Theme — BiliNote

Tailwind CSS **v4**（CSS-first 配置），无 tailwind.config.js，无自定义 tokens。全部样式是 Tailwind 默认调色板的 utility class。

## `assets/tailwind.css`（完整内容）

```css
@import "tailwindcss";
```

## 实际使用的 tokens（从源码统计）

- **Font**：默认系统栈（未设置）；等宽 `font-mono` 用于时间戳、baseURL、API Key
- **Text sizes**：`text-xs`（辅助/按钮小字）、`text-sm`（正文，sidepanel 根节点）、`text-base`（产品名）、`text-xl`（options 标题）
- **Neutrals**：bg `neutral-50`（页底 light）/ `neutral-900`（页底 dark）；surface `white` / `neutral-800`；border `neutral-200` / `neutral-700`；次要文本 `neutral-500` / `neutral-400`
- **Accent**：`sky-600`（按钮底、链接 hover）/ `sky-500`（hover 底）/ `sky-400`（dark 文本）
- **Status**：`red-600/400`、`amber-600/400`、`emerald-600/400`
- **Radius**：`rounded-md`（按钮/输入）、`rounded-lg`（卡片）
- **Spacing**：卡片 `p-4`，section 间距 `space-y-4`（sidepanel）/ `space-y-8`（options），列表 `space-y-1.5`/`space-y-2`
- **Dark mode**：`dark:` variant（Tailwind v4 默认 = prefers-color-scheme 媒体查询）
- **Effects**：无 shadow（扁平）；`animate-pulse`（分析中）；header 背景 `bg-neutral-50/95` 半透明
- **z-index**：header `z-10`
