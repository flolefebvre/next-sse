import type { ReactNode } from "react";

export const metadata = {
  title: "next-sse example",
  description: "The example app of @flefebvre/next-sse.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
