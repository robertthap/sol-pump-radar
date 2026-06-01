import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fff7ed",
          100: "#ffedd5",
          500: "#ff6a00",
          600: "#ea580c",
          700: "#c2410c",
        },
        bg: "rgb(249 250 251)",
        panel: "rgb(255 255 255)",
        border: "rgb(229 231 235)",
        muted: "rgb(107 114 128)",
        fg: "rgb(17 24 39)",
        text: "rgb(17 24 39)",
        accent: "rgb(255 106 0)",
        ok: "rgb(22 163 74)",
        warn: "rgb(217 119 6)",
        bad: "rgb(220 38 38)",
      },
      keyframes: {
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
      },
      animation: {
        shimmer: "shimmer 0.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
