/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,js}"],
  theme: {
    extend: {
      colors: {
        // 取自 Akari 图标:暗底墨绿 + 暖光琥珀
        ink: {
          900: "#0b1210",
          800: "#0e1411",
          700: "#16241d",
          600: "#1d3328"
        },
        ember: {
          50: "#fff3da",
          100: "#ffcf86",
          300: "#fbcb84",
          500: "#f6b65f",
          600: "#f4ad55",
          700: "#ef8a3c"
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'system-ui', 'sans-serif']
      },
      boxShadow: {
        glow: "0 0 80px -10px rgba(246,182,95,0.45)"
      }
    }
  },
  plugins: []
};
