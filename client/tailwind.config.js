/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      // "Velvet Cinema" theme. The app's indigo/violet/fuchsia/slate utility classes are remapped
      // here so every component picks up the new palette without touching its logic.
      colors: {
        ink: {
          950: '#0a0807',
          900: '#120e0c',
          850: '#181310',
          800: '#211a16',
        },
        // indigo -> marquee gold (primary)
        indigo: {
          50: '#fff9eb', 100: '#ffefc6', 200: '#fedd8b', 300: '#fcc85a', 400: '#f5b544',
          500: '#d9932a', 600: '#a8661a', 700: '#854f16', 800: '#6b3f15', 900: '#4a2c10', 950: '#2b1907',
        },
        // violet -> warm copper (secondary)
        violet: {
          50: '#fff5ed', 100: '#ffe7d4', 200: '#fecba8', 300: '#fdab78', 400: '#fb8a4c',
          500: '#ee6c2b', 600: '#c4521c', 700: '#9c3f18', 800: '#7d3318', 900: '#5c2614', 950: '#331309',
        },
        // fuchsia -> velvet crimson (accent, live/recording states)
        fuchsia: {
          50: '#fff1f2', 100: '#ffe0e2', 200: '#fec6cb', 300: '#fd9ba3', 400: '#f9666f',
          500: '#e5484d', 600: '#c22f38', 700: '#a1242e', 800: '#86212b', 900: '#5e1a21', 950: '#360a0f',
        },
        // slate -> warm stone greys
        slate: {
          50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e',
          500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09',
        },
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(245,181,68,0.30), 0 10px 40px -12px rgba(238,108,43,0.55)',
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 50px -20px rgba(0,0,0,0.7)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'scale-in': { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'float-up': {
          '0%': { opacity: '0', transform: 'translateY(0) scale(0.6)' },
          '15%': { opacity: '1', transform: 'translateY(-20px) scale(1.1)' },
          '100%': { opacity: '0', transform: 'translateY(-260px) scale(1)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
        'fade-up': 'fade-up 300ms ease-out both',
        'scale-in': 'scale-in 180ms ease-out both',
        'slide-in-right': 'slide-in-right 260ms cubic-bezier(0.22,1,0.36,1) both',
        'float-up': 'float-up 3s ease-out forwards',
        shimmer: 'shimmer 6s linear infinite',
      },
    },
  },
  plugins: [],
}
