# Extractable Components — BiliNote

只有一个共享组件值得提取；按钮/输入/卡片为内联 class 模式（见 components.md），按规范不提取基础原语。

| Component | Source | Props | 说明 |
|---|---|---|---|
| `TimestampLink` | `components/TimestampLink.tsx` | `seconds: number`, `onSeek: (s:number)=>void` | 等宽字体时间戳链接，点击 seek；出现在大纲/分段/重点所有时间点 |

无 NavBar/Sidebar/Footer 类布局组件（浏览器扩展，每页独立 shell）。
