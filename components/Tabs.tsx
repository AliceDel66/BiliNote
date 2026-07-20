/** 任务 Tab 栏（设计系统：底部发丝线 + 激活项 gradient-brand 2px 指示条） */
export interface TabItem<T extends string> {
  key: T;
  label: string;
}

export default function Tabs<T extends string>(props: {
  tabs: TabItem<T>[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex border-b border-line dark:border-line-dark px-2"
    >
      {props.tabs.map((t) => {
        const active = t.key === props.active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(t.key)}
            className={`relative h-9 px-3 text-[13px] transition-colors duration-150 cursor-pointer ${
              active
                ? 'text-ink dark:text-ink-dark font-medium'
                : 'text-ink-2 dark:text-ink-2-dark hover:text-ink dark:hover:text-ink-dark'
            }`}
          >
            {t.label}
            {active && (
              <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full gradient-brand" />
            )}
          </button>
        );
      })}
    </div>
  );
}
