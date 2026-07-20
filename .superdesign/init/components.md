# Components — BiliNote

Framework: React 18 + TypeScript (WXT extension, Manifest V3). No component library — all UI is hand-written with Tailwind CSS v4 utility classes. There is exactly ONE shared component file; buttons/inputs/badges are inline class patterns documented below.

## `components/TimestampLink.tsx`

可点击的时间戳锚点（mm:ss），点击触发播放器 seek。用于大纲、分段总结、笔记预览中的所有时间点。

```tsx
/** 可点击的时间戳锚点（mm:ss），点击触发播放器跳转 */
import { formatTimestamp } from '../lib/types';

export default function TimestampLink(props: {
  seconds: number;
  onSeek: (seconds: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onSeek(props.seconds)}
      className="font-mono text-sky-600 dark:text-sky-400 hover:underline cursor-pointer bg-transparent border-0 p-0"
      title="跳转到播放器对应位置"
    >
      {formatTimestamp(props.seconds)}
    </button>
  );
}
```

## Inline class patterns (used across pages, no extracted component)

Primary button（一键分析 / 保存）:
```
rounded-md bg-sky-600 hover:bg-sky-500 text-white py-2 font-medium
```

Ghost button（重试 / 检查模型设置 / 拉取模型列表）:
```
rounded-md border border-neutral-300 dark:border-neutral-600 py-1.5 text-xs hover:border-sky-500
```

Link button（重新生成 / 编辑 / 取消）:
```
text-xs text-neutral-500 hover:text-sky-600 dark:hover:text-sky-400
```

Input（options 页 inputCls）:
```
w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-sky-500
```

Card（视频卡 / 结果卡 / 表单卡）:
```
rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-white dark:bg-neutral-800
```

Status text colors: 错误 `text-red-600 dark:text-red-400`，警告 `text-amber-600 dark:text-amber-400`，成功 `text-emerald-600 dark:text-emerald-400`，进行中 `text-sky-600 dark:text-sky-400 animate-pulse`。
