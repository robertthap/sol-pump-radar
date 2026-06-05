import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // GMGN-style green accent (up/buy). brand.* repointed from orange → green
        // so existing bg-brand-500 / btn-brand surfaces become the green accent.
        brand: {
          50: "rgb(22 199 132 / 0.10)",
          100: "rgb(22 199 132 / 0.18)",
          500: "rgb(22 199 132)",
          600: "rgb(13 168 110)",
          700: "rgb(9 132 86)",
        },
        // Dark trading-terminal surfaces (space-separated rgb so /alpha modifiers work).
        bg: "rgb(11 13 16)",
        panel: "rgb(20 22 28)",
        panel2: "rgb(28 30 38)",
        border: "rgb(38 41 50)",
        muted: "rgb(143 148 160)",
        fg: "rgb(233 236 242)",
        text: "rgb(233 236 242)",
        accent: "rgb(22 199 132)",
        ok: "rgb(34 197 94)",
        warn: "rgb(234 179 8)",
        bad: "rgb(244 84 84)",
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
