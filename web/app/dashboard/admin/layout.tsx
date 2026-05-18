import { ReactNode } from 'react'
import { AnnouncementBanner } from '@/components/announcement-banner'
import { AdminSidebar } from '@/components/dashboard/admin-sidebar'

export default function AdminLayout({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-screen flex flex-col bg-background">
            <AnnouncementBanner />
            <div className="flex-1 flex min-h-0">
                <AdminSidebar />
                <main className="flex-1 overflow-auto">{children}</main>
            </div>
        </div>
    )
}
