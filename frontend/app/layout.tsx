import "@fontsource/young-serif/400.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/caveat/600.css";
import "./globals.css";
import "./design.css";
import "./ui.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ProofLearn",
  description: "Teach me anything. Prove I learned it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
