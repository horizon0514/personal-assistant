import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 取自 Akari 图标:暗底墨绿 + 暖光琥珀
        ink: {
          950: "#0b1210",
          900: "#0e1411",
          800: "#16241d",
          700: "#1d3328",
          600: "#27463a"
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
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          "system-ui",
          "sans-serif"
        ]
      },
      boxShadow: {
        glow: "0 0 80px -10px rgba(246,182,95,0.45)"
      }
    }
  },
  plugins: [typography]
};
