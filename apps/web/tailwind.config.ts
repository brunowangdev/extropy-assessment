import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(240 10% 3.9%)',
        muted: 'hsl(240 4.8% 95.9%)',
        'muted-foreground': 'hsl(240 3.8% 46.1%)',
        border: 'hsl(240 5.9% 90%)',
        primary: 'hsl(240 5.9% 10%)',
        'primary-foreground': 'hsl(0 0% 98%)',
        destructive: 'hsl(0 84.2% 60.2%)',
        'destructive-foreground': 'hsl(0 0% 98%)',
      },
      borderRadius: {
        lg: '0.5rem',
        md: '0.375rem',
        sm: '0.25rem',
      },
    },
  },
  plugins: [],
} satisfies Config;
