import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "Cloud0310's blog",
  description: "Tech blog",
  themeConfig: {
    nav: [{ text: "Home", link: "/" }],
    search: { provider: "local" },
    outline: { label: "On this page" },
    socialLinks: [{ icon: "github", link: "https://github.com/Cloud0310" }],
  },
});
