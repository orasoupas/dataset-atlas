import type { Metadata } from 'next';
import { Roboto_Condensed } from 'next/font/google';
import './globals.css';
const robotoCondensed = Roboto_Condensed({ variable: '--font-roboto-condensed', subsets: ['latin'] });
export const metadata: Metadata = {
  metadataBase: new URL('https://orasoupas.github.io/cityquiz-atlas/'),
  icons: { icon: '/cityquiz-atlas/cityquiz.png' },
  title: 'CityQuiz Dataset Atlas',
  description: 'Explore the population datasets used by CityQuiz.',
  openGraph: { title: 'CityQuiz Dataset Atlas', description: 'Explore the population datasets used by CityQuiz.', images: [{ url: '/og.png', width: 1729, height: 910, alt: 'CityQuiz Dataset Atlas map' }] },
  twitter: { card: 'summary_large_image', title: 'CityQuiz Dataset Atlas', description: 'Explore the population datasets used by CityQuiz.', images: ['/og.png'] },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body className={robotoCondensed.variable}>{children}</body></html>; }
