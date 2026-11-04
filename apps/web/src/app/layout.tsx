import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import { AppProviders } from "@/components/app-providers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Resolv.tec | Gestão predial inteligente",
  description: "Plataforma de gestão de manutenção predial da Resolv.tec.",
  manifest: "/manifest.webmanifest",
  applicationName: "Resolv.tec",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Resolv.tec",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${manrope.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
