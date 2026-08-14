'use client'
import { MenuIcon, PackageIcon, Search, ShoppingCart, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSelector } from "react-redux";
import {useUser, useClerk, UserButton, Protect} from "@clerk/nextjs"

const NAV_LINKS = [
    { href: '/', label: 'Home' },
    { href: '/shop', label: 'Shop' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/create-store', label: 'Sell' },
]

const Navbar = () => {

    const {user} = useUser()
    const {openSignIn} = useClerk()
    const router = useRouter()

    const [search, setSearch] = useState('')
    const [menuOpen, setMenuOpen] = useState(false)
    const cartCount = useSelector(state => state.cart.total)

    const handleSearch = (e) => {
        e.preventDefault()
        setMenuOpen(false)
        // Encoded: a term containing & or # would otherwise truncate the query.
        router.push(`/shop?search=${encodeURIComponent(search.trim())}`)
    }

    return (
        <nav className="relative bg-white">
            <div className="mx-6">
                <div className="flex items-center justify-between max-w-7xl mx-auto py-4 transition-all">

                    <Link href="/" className="relative text-4xl font-semibold text-slate-700">
                        <span className="text-green-600">go</span>cart<span className="text-green-600 text-5xl leading-0">.</span>
                        <Protect plan='plus'>
                             <p className="absolute text-xs font-semibold -top-1 -right-8 px-3 p-0.5 rounded-full flex items-center gap-2 text-white bg-green-500">
                            plus
                            </p>
                        </Protect>
                    </Link>

                    <div className="hidden sm:flex items-center gap-4 lg:gap-8 text-slate-600">
                        {NAV_LINKS.map(link => (
                            <Link key={link.href} href={link.href}>{link.label}</Link>
                        ))}

                        <form onSubmit={handleSearch} className="hidden lg:flex items-center w-xs text-sm gap-2 bg-slate-100 px-4 py-3 rounded-full">
                            <Search size={18} className="text-slate-600" />
                            <input className="w-full bg-transparent outline-none placeholder-slate-600" type="text" placeholder="Search products" aria-label="Search products" value={search} onChange={(e) => setSearch(e.target.value)} required />
                        </form>

                        <Link href="/cart" className="relative flex items-center gap-2 text-slate-600">
                            <ShoppingCart size={18} />
                            Cart
                            {/* A span, not a button: an interactive element cannot be nested in a link. */}
                            <span className="absolute -top-1 left-3 text-[8px] text-white bg-slate-600 size-3.5 rounded-full flex items-center justify-center">{cartCount}</span>
                        </Link>

                        {!user ? (
                            <button onClick={openSignIn} className="px-8 py-2 bg-indigo-500 hover:bg-indigo-600 transition text-white rounded-full">
                                Login
                            </button>
                        ) : (
                            <UserButton>
                                <UserButton.MenuItems>
                                    <UserButton.Action labelIcon={<PackageIcon size={16}/>} label="My Orders" onClick={()=> router.push('/orders')}/>
                                </UserButton.MenuItems>
                            </UserButton>
                        )}
                    </div>

                    {/* Below sm the whole menu above is hidden, which previously left
                        a phone with no way to reach the shop, search or the cart. */}
                    <div className="flex items-center gap-3 sm:hidden">
                        <Link href="/cart" aria-label="Cart" className="relative text-slate-600 p-1">
                            <ShoppingCart size={22} />
                            <span className="absolute -top-1 -right-1 text-[9px] text-white bg-slate-600 min-w-4 h-4 px-1 rounded-full flex items-center justify-center">{cartCount}</span>
                        </Link>
                        {user && (
                            <UserButton>
                                <UserButton.MenuItems>
                                    <UserButton.Action labelIcon={<PackageIcon size={16}/>} label="My Orders" onClick={()=> router.push('/orders')}/>
                                </UserButton.MenuItems>
                            </UserButton>
                        )}
                        <button
                            onClick={() => setMenuOpen(open => !open)}
                            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                            aria-expanded={menuOpen}
                            className="text-slate-600 p-1"
                        >
                            {menuOpen ? <XIcon size={24} /> : <MenuIcon size={24} />}
                        </button>
                    </div>
                </div>

                {menuOpen && (
                    <div className="sm:hidden max-w-7xl mx-auto pb-4 flex flex-col gap-1 text-slate-600">
                        <form onSubmit={handleSearch} className="flex items-center text-sm gap-2 bg-slate-100 px-4 py-3 rounded-full mb-2">
                            <Search size={18} className="text-slate-600" />
                            <input className="w-full bg-transparent outline-none placeholder-slate-600" type="text" placeholder="Search products" aria-label="Search products" value={search} onChange={(e) => setSearch(e.target.value)} required />
                        </form>
                        {NAV_LINKS.map(link => (
                            <Link key={link.href} href={link.href} onClick={() => setMenuOpen(false)} className="py-2.5 border-b border-slate-100">
                                {link.label}
                            </Link>
                        ))}
                        {user ? (
                            <Link href="/orders" onClick={() => setMenuOpen(false)} className="py-2.5 border-b border-slate-100">My Orders</Link>
                        ) : (
                            <button onClick={() => { setMenuOpen(false); openSignIn() }} className="mt-3 px-8 py-2 bg-indigo-500 hover:bg-indigo-600 transition text-white rounded-full">
                                Login
                            </button>
                        )}
                    </div>
                )}
            </div>
            <hr className="border-gray-300" />
        </nav>
    )
}

export default Navbar
