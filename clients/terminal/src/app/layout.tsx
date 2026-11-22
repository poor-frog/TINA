import type { Metadata } from "next";
import "./globals.css";
import { Analytics } from "./AnalyticsScript";

export const metadata: Metadata = {
  title: "TINA — AI Meeting Companion",
  description:
    "Self-hosted meeting bots, live bilingual transcription, grounded notes, and developer workbench.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        {/* apply the saved theme before first paint so day mode doesn't flash dark on reload */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem('tina.terminal.theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}` }} />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
