# Pages — BiliNote

## Side Panel（主界面，`sidepanel.html`）

Entry: `entrypoints/sidepanel/App.tsx`
Dependencies:
- `components/TimestampLink.tsx`
  - `lib/types.ts`（formatTimestamp）
- `lib/messages.ts`（ANALYZE_PORT、消息类型，纯类型/常量，无 UI）
- `lib/summarize/index.ts`（AnalysisResult 类型，无 UI）
- `entrypoints/sidepanel/main.tsx`（React 挂载）
- `entrypoints/sidepanel/index.html`
- `assets/tailwind.css`（全局样式）

## Options（设置页，`options.html`）

Entry: `entrypoints/options/App.tsx`
Dependencies:
- `lib/storage/index.ts`（profiles/prefs CRUD，无 UI）
- `entrypoints/options/main.tsx`
- `entrypoints/options/index.html`
- `assets/tailwind.css`（全局样式）
