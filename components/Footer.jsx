import Link from "next/link";

const Footer = () => {

    const MailIcon = () => (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M14.6654 4.66699L8.67136 8.48499C8.46796 8.60313 8.23692 8.66536 8.0017 8.66536C7.76647 8.66536 7.53544 8.60313 7.33203 8.48499L1.33203 4.66699M2.66536 2.66699H13.332C14.0684 2.66699 14.6654 3.26395 14.6654 4.00033V12.0003C14.6654 12.7367 14.0684 13.3337 13.332 13.3337H2.66536C1.92898 13.3337 1.33203 12.7367 1.33203 12.0003V4.00033C1.33203 3.26395 1.92898 2.66699 2.66536 2.66699Z" stroke="#90A1B9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> </svg>)
    const GithubIcon = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" stroke="#90A1B9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> </svg>)

    const linkSections = [
        {
            title: "PRODUCTS",
            links: [
                { text: "Earbuds", path: '/shop?search=Earbuds', icon: null },
                { text: "Headphones", path: '/shop?search=Headphones', icon: null },
                { text: "Speakers", path: '/shop?search=Speakers', icon: null },
                { text: "Watches", path: '/shop?search=Watch', icon: null },
                { text: "Mice", path: '/shop?search=Mouse', icon: null },
                { text: "Gaming", path: '/shop?search=Gaming', icon: null },
            ]
        },
        {
            title: "EXPLORE",
            links: [
                { text: "Home", path: '/', icon: null },
                { text: "All Products", path: '/shop', icon: null },
                { text: "Become Plus Member", path: '/pricing', icon: null },
                { text: "Create Your Store", path: '/create-store', icon: null },
                { text: "About this project", path: '/about', icon: null },
            ]
        },
        {
            title: "CONTACT",
            links: [
                { text: "manavsinglase27@gmail.com", path: "mailto:manavsinglase27@gmail.com", icon: MailIcon },
                { text: "Source on GitHub", path: "https://github.com/ManavS24/GoCart", icon: GithubIcon },
            ]
        }
    ];

    // Only accounts that exist. A row of icons linking to facebook.com is
    // decoration pretending to be a presence.
    const socialIcons = [
        { icon: GithubIcon, link: "https://github.com/ManavS24/GoCart", label: "GitHub" },
    ]

    return (
        <footer className="mx-6 bg-white">
            <div className="max-w-7xl mx-auto">
                <div className="flex flex-col md:flex-row items-start justify-between gap-10 py-10 border-b border-slate-500/30 text-slate-500">
                    <div>
                        <Link href="/" className="text-4xl font-semibold text-slate-700">
                            <span className="text-green-600">go</span>cart<span className="text-green-600 text-5xl leading-0">.</span>
                        </Link>
                        <p className="max-w-[410px] mt-6 text-sm">A small multi-vendor marketplace for audio, wearables and home tech. Every store here is reviewed before its products reach the storefront.</p>
                        <div className="flex items-center gap-3 mt-5">
                            {socialIcons.map((item, i) => (
                                <a href={item.link} key={i} target="_blank" rel="noopener noreferrer" aria-label={item.label} className="flex items-center justify-center w-10 h-10 bg-slate-100 hover:scale-105 hover:border border-slate-300 transition rounded-full">
                                    <item.icon />
                                </a>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap justify-between w-full md:w-[45%] gap-5 text-sm ">
                        {linkSections.map((section, index) => (
                            <div key={index}>
                                <h3 className="font-medium text-slate-700 md:mb-5 mb-3">{section.title}</h3>
                                <ul className="space-y-2.5">
                                    {section.links.map((link, i) => (
                                        <li key={i} className="flex items-center gap-2">
                                            {link.icon && <link.icon />}
                                            {link.path?.startsWith('/')
                                                ? <Link href={link.path} className="hover:underline transition">{link.text}</Link>
                                                : <a href={link.path} target={link.path?.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="hover:underline transition">{link.text}</a>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
                <p className="py-4 text-sm text-slate-500">
                    © {new Date().getFullYear()} GoCart — an educational project, not a real marketplace.
                </p>
            </div>
        </footer>
    );
};

export default Footer;