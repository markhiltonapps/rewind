import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rwbg: '#070a14', rwpanel: '#0f1526', rwpanel2: '#0b1120',
        rwtext: '#eef1f8', rwtext2: '#aeb8d0', rwtext3: '#7f8db0',
        accentFrom: '#6ea8ff', accentTo: '#9b7bff',
      },
      borderColor: { rwline: 'rgba(255,255,255,0.08)' },
      backgroundImage: {
        'rw-hero': 'radial-gradient(120% 120% at 50% 0%, #1b2440 0%, #0b0f1c 60%, #070a14 100%)',
        'rw-accent': 'linear-gradient(135deg, #6ea8ff, #9b7bff)',
      },
    },
  },
  plugins: [],
};
export default config;
