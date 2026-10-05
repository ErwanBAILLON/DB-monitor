import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/components/**/*.{ts,tsx}", "./src/app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        fond: token("fond"), // page
        encre: token("encre"), // ink
        gris: token("gris"), // secondary text
        carte: token("carte"), // cards, inputs
        trait: token("trait"), // hairlines
        ok: token("ok"), // up
        alerte: token("alerte"), // warning
        panne: token("panne"), // down, danger
        accent: token("accent"), // actions, links
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
