import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "./components/AuthProvider";

export const metadata: Metadata = {
  title: "Trion — by Nomin",
  description: "Nomin's browser-based coding agent workspace",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#100a24" },
    { media: "(prefers-color-scheme: light)", color: "#fbfbff" },
  ],
};

/**
 * Resolve the theme BEFORE first paint.
 *
 * Light remains the first-ever default, while an explicit user choice persists
 * across every route and later visit. Resolve it before paint to avoid a flash.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("nomin-theme");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light")}catch(e){document.documentElement.setAttribute("data-theme","light")}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body><AuthProvider>{children}</AuthProvider></body>
    </html>
  );
}
