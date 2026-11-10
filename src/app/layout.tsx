import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The printed layer's voice. Findings sit on bone cards like inserts in a
// research binder, and a serif is what makes them read as printed.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

/**
 * Where relative metadata URLs resolve from. Vercel sets VERCEL_URL on every
 * deployment including previews, so a branch deploy advertises its own images
 * rather than production's. SITE_URL overrides it for a custom domain.
 */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

const title = "Vision. See the problem, defend the answer";
const description =
  "Submit a product. A simulated market tells you which problem it actually solves, then an investment committee decides whether that problem is big enough.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "Vision",
  // Without these, the link is a bare URL everywhere it gets pasted. The card
  // image itself is generated at src/app/opengraph-image.tsx.
  openGraph: {
    title,
    description,
    url: siteUrl,
    siteName: "Vision",
    type: "website",
    locale: "en_CA",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

/**
 * Runs before the first paint. "/" is prerendered as the introduction, because
 * the server cannot see localStorage; a founder who already has saved projects
 * would otherwise watch the introduction flash past on every visit. This marks
 * the document so the stylesheet can keep it hidden until their list replaces
 * it. Must match the persist key in src/lib/sessions.ts.
 */
const returningScript = `try{var s=JSON.parse(localStorage.getItem("vision.sessions")||"null");if(s&&s.state&&s.state.sessions&&s.state.sessions.length)document.documentElement.dataset.returning="1"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
      // The script below adds an attribute to this element before hydration.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: returningScript }} />
        {children}
        <div className="grain" aria-hidden />
      </body>
    </html>
  );
}
