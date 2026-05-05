import './globals.css'
import { Inter } from 'next/font/google'
import Sidebar from '@/components/Sidebar'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import MainContent from '@/components/MainContent'

// Phase 4 Task 2: Inter at 400 + 500 only. Heavier weights look heavy
// against the new spacing — the Premium Minimalism reference relies on
// hierarchy from size and color, not weight.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-inter',
})

export { metadata } from './metadata'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} font-sans bg-rw-bg-app text-rw-text-primary`}
      >
        <SidebarProvider>
          <div className="titlebar h-8 w-full fixed top-0 left-0 bg-transparent" />
          <div className="flex">
            <Sidebar />
            <MainContent>{children}</MainContent>
          </div>
        </SidebarProvider>
      </body>
    </html>
  )
}
