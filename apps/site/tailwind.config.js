/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,js}"],
  theme: {
    extend: {
      colors: {
        // 暗色精密派:中性近黑画布 + 灯光琥珀强调(与桌面端一致)
        ink: {
          950: "#0b0c0e",
          900: "#121317",
          800: "#1a1c21",
          700: "#23262c",
          600: "#31353d"
        },
        ember: {
          50: "#fff5e1",
          100: "#ffe6bd",
          300: "#ffcd76",
          400: "#f9b443",
          500: "#f3a738",
          600: "#dd9020",
          700: "#b06d13"
        }
      },
      fontFamily: {
        sans: ['Inter', '"Noto Sans SC"', '-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', '"SF Mono"', 'monospace']
      },
      boxShadow: {
        glow: "0 0 60px -12px rgba(243,167,56,0.40)"
      }
    }
  },
  plugins: []
};
