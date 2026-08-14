import AdminLayout from "@/components/admin/AdminLayout";
import {SignedIn, SignedOut, SignIn} from "@clerk/nextjs"

export const metadata = {
    title: "Admin — GoCart",
    description: "Review store applications, manage stores and issue coupons.",
};

export default function RootAdminLayout({ children }) {

    return (
        <>
            <SignedIn>
                <AdminLayout>
                {children}
                </AdminLayout>
            </SignedIn>
            <SignedOut>
                <div className="min-h-screen flex items-center justify-center">
                    <SignIn fallbackRedirectUrl="/admin" routing="hash"/>
                </div>
            </SignedOut>
        </>
    );
}
