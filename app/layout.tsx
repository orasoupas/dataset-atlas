import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
export const metadata: Metadata = {
  metadataBase: new URL('https://cityquiz-dataset-atlas.icy-knoll-0811.chatgpt.site'),
  title: 'CityQuiz Dataset Atlas', description: 'Explore new community-built CityQuiz datasets, place by place.',
  openGraph: { title: 'CityQuiz Dataset Atlas', description: 'Explore new community-built CityQuiz datasets, place by place.', images: [{ url: '/og.png', width: 1729, height: 910, alt: 'CityQuiz Dataset Atlas map of Mexico' }] },
  twitter: { card: 'summary_large_image', title: 'CityQuiz Dataset Atlas', description: 'Explore new community-built CityQuiz datasets, place by place.', images: ['/og.png'] },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>; }
