import upload_area from "./upload_area.svg"
import hero_model_img from "./hero_model_img.png"
import hero_product_img1 from "./hero_product_img1.png"
import hero_product_img2 from "./hero_product_img2.png"
import { BadgeCheckIcon, LockIcon, SendIcon } from "lucide-react";

export const assets = {
    upload_area,
    hero_model_img,
    hero_product_img1,
    hero_product_img2,
}

export const categories = ["Headphones", "Speakers", "Watch", "Earbuds", "Mouse", "Accessories", "Home"];

export const ourSpecsData = [
    { title: "Free shipping on Plus", description: "Plus members pay no delivery charge on any order. Everyone else pays a flat fee per order.", icon: SendIcon, accent: '#05DF72' },
    { title: "Verified sellers only", description: "Every store is reviewed and approved before a single product of theirs reaches the storefront.", icon: BadgeCheckIcon, accent: '#FF8904' },
    { title: "Secure checkout", description: "Payments are handled by Razorpay. Card details are never seen by, or stored on, this site.", icon: LockIcon, accent: '#A684FF' }
]
