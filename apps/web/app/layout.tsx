import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Knowledge Copilot",
  description: "PDF question-answering demo with semantic search, streaming, and analytics.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-white antialiased`}
      >
        <div className="border-b border-slate-200/80 bg-white/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 text-sm md:px-6">
            <Link href="/" className="font-semibold tracking-[0.16em] text-slate-900 uppercase">
              Knowledge Copilot
            </Link>
            <div className="flex items-center gap-2 text-slate-600">
              <Link href="/" className="rounded-full px-3 py-1.5 transition hover:bg-slate-100">
                Chat
              </Link>
              <Link
                href="/stats"
                className="rounded-full px-3 py-1.5 transition hover:bg-slate-100"
              >
                Stats
              </Link>
            </div>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
