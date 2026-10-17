import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HarborMind | Maritime Resilience Platform",
  description: "A port disruption digital twin and interactive maritime scenario sandbox.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
