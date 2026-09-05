import type { Metadata } from 'next';
import { Roboto_Condensed } from 'next/font/google';
import './globals.css';
const robotoCondensed = Roboto_Condensed({ variable: '--font-roboto-condensed', subsets: ['latin'] });
export const metadata: Metadata = {
  metadataBase: new URL('https://orasoupas.github.io/cityquiz-dataset-atlas/'),
  icons: { icon: '/cityquiz-dataset-atlas/cityquiz.png' },
  title: 'CityQuiz Dataset Atlas',
  openGraph: { title: 'CityQuiz Dataset Atlas' },
  twitter: { card: 'summary', title: 'CityQuiz Dataset Atlas' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body className={robotoCondensed.variable}>{children}</body></html>; }
