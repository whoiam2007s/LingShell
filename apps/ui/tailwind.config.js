/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // 颜色 token 指向 index.css 的变量（随深色 / 浅色主题切换）
      colors: {
        bg: {
          base: 'var(--color-bg-base)',
          panel: 'var(--color-bg-panel)',
          raised: 'var(--color-bg-raised)',
          hover: 'var(--color-bg-hover)',
        },
        border: {
          subtle: 'var(--color-border-subtle)',
          DEFAULT: 'var(--color-border-default)',
          strong: 'var(--color-border-strong)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
        },
        accent: {
          DEFAULT: 'var(--color-accent)',
          dim: 'var(--color-accent-dim)',
          bg: 'var(--color-accent-bg)',
        },
        user: 'var(--color-user)',
        success: 'var(--color-success)',
        warn: 'var(--color-warn)',
        danger: 'var(--color-danger)',
        reasoning: 'var(--color-reasoning)',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      keyframes: {
        'ai-spin': { to: { transform: 'rotate(360deg)' } },
        'ai-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
        'ai-blink': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
        'ai-fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'spin-slow': 'ai-spin 0.8s linear infinite',
        'pulse-dim': 'ai-pulse 1.5s ease-in-out infinite',
        'fade-in': 'ai-fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [],
}
