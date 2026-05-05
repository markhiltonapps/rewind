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
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Phase 4 Task 2: Premium Minimalism tokens. Backed by the
        // --rw-* CSS variables in globals.css. Use as bg-rw-card,
        // text-rw-text-secondary, border-rw-border, etc.
        rw: {
          primary: "var(--rw-color-primary)",
          "primary-hover": "var(--rw-color-primary-hover)",
          "primary-bg": "var(--rw-color-primary-bg)",
          "bg-app": "var(--rw-color-bg-app)",
          card: "var(--rw-color-bg-card)",
          subtle: "var(--rw-color-bg-subtle)",
          hover: "var(--rw-color-bg-hover)",
          "text-primary": "var(--rw-color-text-primary)",
          "text-secondary": "var(--rw-color-text-secondary)",
          "text-tertiary": "var(--rw-color-text-tertiary)",
          "text-on-primary": "var(--rw-color-text-on-primary)",
          border: "var(--rw-color-border)",
          "border-strong": "var(--rw-color-border-strong)",
          "success-bg": "var(--rw-color-success-bg)",
          "success-text": "var(--rw-color-success-text)",
          "warning-bg": "var(--rw-color-warning-bg)",
          "warning-text": "var(--rw-color-warning-text)",
          "danger-bg": "var(--rw-color-danger-bg)",
          "danger-text": "var(--rw-color-danger-text)",
          "info-bg": "var(--rw-color-info-bg)",
          "info-text": "var(--rw-color-info-text)",
        },
      },
      borderRadius: {
        // 6 / 10 / 14 chips / buttons / cards.
        "rw-sm": "6px",
        "rw-md": "10px",
        "rw-lg": "14px",
      },
      boxShadow: {
        // No card shadows — drop shadows reserved for modals and
        // active dropdowns.
        "rw-modal": "0 4px 24px rgba(0, 0, 0, 0.08)",
        "rw-dropdown": "0 2px 8px rgba(0, 0, 0, 0.05)",
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
} satisfies Config;
