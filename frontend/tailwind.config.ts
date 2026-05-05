import type { Config } from "tailwindcss";

export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Phase 4 Task 2: Inter via next/font sets --font-inter on the
        // body. Tailwind's font-sans utility resolves to this stack so
        // every component picks up Inter without per-element classes.
        sans: [
          "var(--font-inter)",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        // Phase 4 Task 2.5: IBM Plex Mono — accent typeface for the
        // NEATO_REWIND wordmark, REC indicator timer, keyboard hint
        // pills, and transcript timestamps.
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Phase 4 Task 2.5 hotfix: Tailwind silently drops generated
        // rules when a nested color key collides with a utility prefix.
        // The previous nested form `rw: { 'bg-app': '...' }` produced
        // class names like `bg-rw-bg-app` and `text-rw-text-primary`,
        // which Tailwind couldn't disambiguate against its own `bg-*`
        // and `text-*` utility prefixes — so the rules were never
        // emitted and the entire warm Neato palette rendered as white.
        // Flat top-level keys avoid the collision; component class
        // names are unchanged.
        "rw-bg-app": "var(--rw-bg-app)",
        "rw-bg-recede": "var(--rw-bg-recede)",
        "rw-card": "var(--rw-bg-card)",
        "rw-subtle": "var(--rw-bg-subtle)",
        "rw-hover": "var(--rw-bg-hover)",

        "rw-text-primary": "var(--rw-text-primary)",
        "rw-text-secondary": "var(--rw-text-secondary)",
        "rw-text-tertiary": "var(--rw-text-tertiary)",
        "rw-text-on-primary": "var(--rw-text-on-primary)",

        "rw-border": "var(--rw-border)",
        "rw-border-strong": "var(--rw-border-strong)",

        "rw-primary": "var(--rw-primary)",
        "rw-primary-hover": "var(--rw-primary-hover)",
        "rw-primary-bg": "var(--rw-primary-bg)",
        "rw-primary-border": "var(--rw-primary-border)",

        "rw-coral": "var(--rw-coral)",
        "rw-coral-bg": "var(--rw-coral-bg)",
        "rw-coral-text": "var(--rw-coral-text)",

        "rw-success-bg": "var(--rw-success-bg)",
        "rw-success-text": "var(--rw-success-text)",
        "rw-warning-bg": "var(--rw-warning-bg)",
        "rw-warning-text": "var(--rw-warning-text)",
        "rw-danger-bg": "var(--rw-danger-bg)",
        "rw-danger-text": "var(--rw-danger-text)",
        "rw-info-bg": "var(--rw-info-bg)",
        "rw-info-text": "var(--rw-info-text)",
      },
      borderRadius: {
        // 6 / 10 / 14 chips / buttons / cards.
        "rw-sm": "6px",
        "rw-md": "10px",
        "rw-lg": "14px",
      },
      boxShadow: {
        // Phase 4 Task 2.5: modal shadow strengthened so the panel
        // visibly floats above the dimmed page (fixes "modal looked
        // transparent" complaint — the dim was reading as bleed).
        "rw-modal":
          "0 8px 32px rgba(31, 30, 27, 0.18), 0 2px 8px rgba(31, 30, 27, 0.08)",
        "rw-dropdown": "0 4px 16px rgba(31, 30, 27, 0.10)",
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
} satisfies Config;
