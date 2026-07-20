# Layouts — BiliNote

This is a browser extension: there is NO shared layout component. Each entrypoint (side panel, options page) renders its own shell. The two shell patterns below appear on their respective pages and must be preserved in spirit.

## Side Panel shell（`entrypoints/sidepanel/App.tsx`）

窄栏（Chrome side panel，约 360–420px 宽）。Sticky 顶栏 + 内容列。

```tsx
<div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-sm">
  <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50/95 dark:bg-neutral-900/95">
    <h1 className="font-bold text-base">BiliNote</h1>
    <button
      type="button"
      className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-sky-600 dark:hover:text-sky-400"
    >
      模型设置
    </button>
  </header>
  <main className="p-4 space-y-4">{/* 视频卡片、分析状态、结果卡片列表 */}</main>
</div>
```

## Options page shell（`entrypoints/options/App.tsx`）

整页标签页（chrome://extensions 打开），居中窄列 max-w-2xl。

```tsx
<div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100">
  <main className="mx-auto max-w-2xl p-6 space-y-8">
    <header>
      <h1 className="text-xl font-bold">BiliNote 设置</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        模型服务配置（BYOK）。API Key 仅保存在本地（chrome.storage.local），不会同步也不会上传。
      </p>
    </header>
    {/* section：已保存的配置（列表）、新增/编辑配置（表单卡） */}
  </main>
</div>
```
