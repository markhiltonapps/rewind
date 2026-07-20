import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Neato Rewind — Never lose a meeting again',
  description:
    'Auto-records, transcribes, and summarizes your Teams & Google Meet calls — privately, on your PC.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-rwbg text-rwtext antialiased">{children}</body>
    </html>
  );
}
