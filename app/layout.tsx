import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LIFFProvider } from "../providers/liff-providers";

export const metadata: Metadata = {
  title: "On My Gelato｜會員與點餐",
  description: "On My Gelato 義式冰淇淋會員與線上點餐",
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1.0,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW">
      <body>
        <LIFFProvider>{children}</LIFFProvider>
      </body>
    </html>
  );
}
