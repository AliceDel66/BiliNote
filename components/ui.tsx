/** BiliNote 共享 UI 原语 —— 对应 .superdesign/design-system.md v2 的组件规格。
 *  全部明暗双主题（dark: 跟随系统），统一 150–200ms ease-out 过渡。 */
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// ---------- Button ----------

type ButtonVariant = 'primary' | 'ghost' | 'link' | 'dangerGhost';
type ButtonSize = 'sm' | 'md' | 'lg';

const btnBase =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 ease-out active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none cursor-pointer';

const btnVariants: Record<ButtonVariant, string> = {
  // 主 CTA：品牌渐变 + 彩色投影（渐变只出现在这类按钮/logo/进度条）
  primary: 'gradient-brand cta-shadow text-white hover:brightness-105',
  ghost:
    'border border-line-2 dark:border-line-2-dark text-ink-2 dark:text-ink-2-dark hover:border-brand-500 hover:text-brand-500 dark:hover:border-brand-300 dark:hover:text-brand-300 bg-transparent',
  link: 'text-ink-2 dark:text-ink-2-dark hover:text-brand-500 dark:hover:text-brand-300 bg-transparent',
  dangerGhost:
    'border border-line-2 dark:border-line-2-dark text-ink-2 dark:text-ink-2-dark hover:border-red-500 hover:text-red-500 bg-transparent',
};

const btnSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-10 px-4 text-sm w-full',
};

export function Button({
  variant = 'ghost',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={`${btnBase} ${btnVariants[variant]} ${btnSizes[size]} ${className}`}
      {...rest}
    />
  );
}

// ---------- Card ----------

export function Card({
  className = '',
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={`rounded-[14px] border border-line dark:border-line-dark bg-card dark:bg-card-dark card-shadow dark:card-highlight p-4 ${className}`}
      {...rest}
    />
  );
}

// ---------- Badge ----------

type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export type { BadgeTone };

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 dark:bg-surface-2-dark text-ink-2 dark:text-ink-2-dark',
  brand: 'bg-brand-soft dark:bg-brand-soft-dark text-brand-500 dark:text-brand-300',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

export function Badge({
  tone = 'neutral',
  className = '',
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeTones[tone]} ${className}`}
      {...rest}
    />
  );
}

// ---------- ProgressBar ----------

export function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="h-1 w-full rounded-full bg-surface-2 dark:bg-surface-2-dark overflow-hidden">
      <div
        className="h-full rounded-full gradient-brand transition-[width] duration-200 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------- Input ----------

export function Input({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-lg border border-line-2 dark:border-line-2-dark bg-card dark:bg-card-dark px-3 text-sm text-ink dark:text-ink-dark placeholder:text-ink-3 dark:placeholder:text-ink-3-dark outline-none transition-colors duration-150 focus:border-brand-500 focus:ring-2 focus:ring-brand-ring dark:focus:ring-brand-ring-dark ${className}`}
      {...rest}
    />
  );
}

// ---------- Switch（偏好开关：w-9 h-5 轨道 + 16px 白色旋钮，开启时品牌渐变） ----------

export function Switch({
  checked,
  onChange,
  className = '',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 ease-out cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
        checked ? 'gradient-brand' : 'bg-line-2 dark:bg-line-2-dark'
      } ${className}`}
      {...rest}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}

// ---------- SectionTitle（结果卡标题行：图标 + 标题 + 右侧槽位） ----------

export function SectionTitle(props: {
  icon: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="text-brand-500 dark:text-brand-300 [&>svg]:w-4 [&>svg]:h-4">
        {props.icon}
      </span>
      <h3 className="text-[15px] font-medium tracking-tight text-ink dark:text-ink-dark flex-1 min-w-0 truncate">
        {props.title}
      </h3>
      {props.aside && (
        <span className="shrink-0 text-xs text-ink-2 dark:text-ink-2-dark">{props.aside}</span>
      )}
    </div>
  );
}
