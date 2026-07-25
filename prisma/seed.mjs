// Populates a fresh database with a demo-ready catalogue: three sellers (two
// live, one awaiting approval so the admin flow has something to act on),
// sixteen products, coupons and ratings.
//
// Product imagery is uploaded to ImageKit from assets/ on first run and reused
// afterwards. Every write is an upsert, so the script is safe to re-run.
//
//   npm run seed

import { PrismaClient } from '@prisma/client'
import ImageKit from 'imagekit'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `prisma db seed` loads .env, but support a bare `node prisma/seed.mjs` too.
if (!process.env.DATABASE_URL && existsSync(resolve(ROOT, '.env'))) {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const i = t.indexOf('=')
        if (i > 0) process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
    }
}

const prisma = new PrismaClient()

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
})

// Uploads assets/<file> once and returns an optimised URL. `overwriteFile`
// with a stable name keeps re-runs from filling the media library with copies.
const uploaded = new Map()
const upload = async (file, folder) => {
    if (uploaded.has(file)) return uploaded.get(file)
    const path = resolve(ROOT, 'assets', file)
    if (!existsSync(path)) throw new Error(`missing asset: assets/${file}`)

    const res = await imagekit.upload({
        file: readFileSync(path),
        fileName: file,
        folder,
        useUniqueFileName: false,
        overwriteFile: true,
    })
    const url = imagekit.url({
        path: res.filePath,
        transformation: [{ quality: 'auto' }, { format: 'webp' }, { width: '1024' }],
    })
    uploaded.set(file, url)
    return url
}

const SELLERS = [
    { id: 'seed_user_greatstack', name: 'Great Stack', email: 'greatstack@example.com',
      store: { id: 'seed_store_greatstack', name: 'GreatStack', username: 'greatstack',
               logo: 'gs_logo.jpg', status: 'approved', isActive: true,
               description: 'Coding and tech goodies, curated for builders. Keyboards, audio and desk gear that earn their place.',
               address: '123 Maplewood Drive, Springfield, IL 62704, USA', contact: '+1 217 555 0142' } },
    { id: 'seed_user_happyshop', name: 'Happy Shop', email: 'happyshop@example.com',
      store: { id: 'seed_store_happyshop', name: 'Happy Shop', username: 'happyshop',
               logo: 'happy_store.webp', status: 'approved', isActive: true,
               description: 'Everyday electronics without the markup. Fast shipping, honest prices, no gimmicks.',
               address: '3rd Floor, New Building, 123 C Sector, New York, NY, USA', contact: '+1 646 555 0188' } },
    // Pending on purpose: gives the admin approval screen something to act on.
    { id: 'seed_user_novatech', name: 'Nova Tech', email: 'novatech@example.com',
      store: { id: 'seed_store_novatech', name: 'Nova Tech', username: 'novatech',
               logo: 'gs_logo.jpg', status: 'pending', isActive: false,
               description: 'Audio specialists. Applying to sell studio monitors and reference headphones.',
               address: '88 Harbour Street, Seattle, WA 98101, USA', contact: '+1 206 555 0119' } },
]

const PRODUCTS = [
    ['Modern Table Lamp',        'Warm, dimmable desk lighting with a machined aluminium body. Three brightness levels and a USB-C passthrough so it earns its footprint.', 40, 29, 'Decoration', 'product_img1.png',  'seed_store_greatstack'],
    ['Smart Speaker (Graphite)', 'Room-filling sound from a speaker that disappears into the shelf. Multi-room pairing and a far-field mic that actually hears you.',        60, 44, 'Speakers',   'product_img2.png',  'seed_store_greatstack'],
    ['Smart Watch (Silver)',     'Seven-day battery, always-on AMOLED, and sleep tracking that does not need a subscription to be useful.',                                  90, 69, 'Watch',      'product_img3.png',  'seed_store_greatstack'],
    ['Wireless Headphones',      'Over-ear ANC with 40mm drivers and a 30-hour charge. Folds flat, travels well, and the case is not the size of a melon.',                 120, 89, 'Headphones', 'product_img4.png',  'seed_store_greatstack'],
    ['Smart Watch (Midnight)',   'The silver model in a darker finish, with a sapphire crystal and a titanium case that shrugs off desk knocks.',                           110, 79, 'Watch',      'product_img5.png',  'seed_store_greatstack'],
    ['Security Camera',          '2K indoor camera with on-device person detection, so routine footage never leaves your network.',                                          75, 55, 'Decoration', 'product_img6.png',  'seed_store_greatstack'],
    ['Stylus Pen',               'Tilt-sensitive stylus with magnetic charging and 4096 pressure levels. Palm rejection that holds up mid-sketch.',                          95, 72, 'Mouse',      'product_img7.png',  'seed_store_greatstack'],
    ['Home Theater System',      '5.1 channel setup with a wireless subwoofer and room calibration that takes about ninety seconds.',                                       320, 249, 'Speakers',   'product_img8.png',  'seed_store_greatstack'],
    ['Wireless Earbuds',         'Compact ANC earbuds with a low-latency gaming mode and wireless charging. Six hours a charge, twenty-four in the case.',                  130, 99, 'Earbuds',    'product_img9.png',  'seed_store_happyshop'],
    ['Smart Watch (Sport)',      'GPS, heart-rate and a 50m water rating in a 32g frame you forget you are wearing.',                                                       180, 139, 'Watch',      'product_img10.png', 'seed_store_happyshop'],
    ['RGB Gaming Mouse',         '26K DPI optical sensor, 58g chassis and onboard memory for five profiles. Per-key lighting if you want it.',                               65, 45, 'Mouse',      'product_img11.png', 'seed_store_happyshop'],
    ['Robot Vacuum',             'LiDAR mapping with no-go zones and a self-emptying dock. Handles cables better than most in its class.',                                  399, 299, 'Decoration', 'product_img12.png', 'seed_store_happyshop'],
    ['Studio Monitor Speakers',  'Near-field monitors with a flat response and front-facing ports, so they behave close to a wall.',                                        280, 219, 'Speakers',   'product_img13.png', 'seed_store_happyshop'],
    ['Noise Cancelling Headset', 'Broadcast-grade boom mic with hybrid ANC. Made for long calls, not just long flights.',                                                   150, 115, 'Headphones', 'product_img14.png', 'seed_store_happyshop'],
    ['Sport Earbuds',            'Hooked, sweat-sealed earbuds that stay put through intervals. IPX7 and a five-minute quick charge.',                                       85, 62, 'Earbuds',    'product_img15.png', 'seed_store_happyshop'],
    ['Ergonomic Vertical Mouse', 'A 57-degree vertical grip that takes the twist out of your forearm, with silent switches.',                                                70, 52, 'Mouse',      'product_img16.png', 'seed_store_happyshop'],
]

const BUYERS = [
    { id: 'seed_user_kristin', name: 'Kristin Watson', email: 'kristin.watson@example.com' },
    { id: 'seed_user_jenny',   name: 'Jenny Wilson',   email: 'jenny.wilson@example.com' },
    { id: 'seed_user_bessie',  name: 'Bessie Cooper',  email: 'bessie.cooper@example.com' },
]

const REVIEWS = [
    [5, 'Better than I expected at this price. Two weeks in and the build still feels premium.'],
    [4, 'Does exactly what it claims. Setup took a few minutes longer than the box suggests, but no complaints.'],
    [5, 'Second one I have bought. Shipping was quick and it arrived properly packed.'],
    [4, 'Solid product. Docking a star only because the manual is nearly useless.'],
]

const COUPONS = [
    // NEW20 is advertised by the site banner; the demo breaks without it.
    { code: 'NEW20',  description: '20% off your first order', discount: 20, forNewUser: true,  forMember: false, isPublic: true },
    { code: 'OFF10',  description: '10% off everything',       discount: 10, forNewUser: false, forMember: false, isPublic: true },
    { code: 'PLUS15', description: '15% off for Plus members', discount: 15, forNewUser: false, forMember: true,  isPublic: true },
]

const main = async () => {
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)

    console.log('Uploading images to ImageKit...')
    const logos = {}
    for (const s of SELLERS) logos[s.store.logo] ??= await upload(s.store.logo, 'logos')
    const images = {}
    for (const [, , , , , file] of PRODUCTS) images[file] ??= await upload(file, 'products')
    console.log(`  ${uploaded.size} image(s) ready`)

    console.log('Seeding sellers and stores...')
    for (const { id, name, email, store } of SELLERS) {
        await prisma.user.upsert({
            where: { id },
            update: { name, email },
            create: { id, name, email, image: logos[store.logo] },
        })
        const { logo, ...rest } = store
        const data = { ...rest, userId: id, email, logo: logos[logo] }
        await prisma.store.upsert({ where: { id: store.id }, update: data, create: data })
    }

    console.log('Seeding buyers...')
    for (const b of BUYERS) {
        await prisma.user.upsert({
            where: { id: b.id },
            update: { name: b.name },
            create: { ...b, image: logos['gs_logo.jpg'] },
        })
    }

    console.log('Seeding products...')
    const created = []
    for (const [i, [name, description, mrp, price, category, file, storeId]] of PRODUCTS.entries()) {
        const id = `seed_product_${String(i + 1).padStart(2, '0')}`
        const data = { name, description, mrp, price, category, storeId, images: [images[file]], inStock: true }
        created.push(await prisma.product.upsert({ where: { id }, update: data, create: { id, ...data } }))
    }

    console.log('Seeding ratings...')
    let n = 0
    for (const [i, product] of created.entries()) {
        // Two or three reviews per product, rotated so the catalogue looks organic.
        for (let j = 0; j < 2 + (i % 2); j++) {
            const buyer = BUYERS[(i + j) % BUYERS.length]
            const [rating, review] = REVIEWS[(i + j) % REVIEWS.length]
            const orderId = `seed_order_${i}_${j}`
            await prisma.rating.upsert({
                where: { userId_productId_orderId: { userId: buyer.id, productId: product.id, orderId } },
                update: { rating, review },
                create: { userId: buyer.id, productId: product.id, orderId, rating, review },
            })
            n++
        }
    }

    console.log('Seeding coupons...')
    for (const c of COUPONS) {
        await prisma.coupon.upsert({
            where: { code: c.code },
            update: { ...c, expiresAt },
            create: { ...c, expiresAt },
        })
    }

    const live = SELLERS.filter(s => s.store.status === 'approved').length
    console.log(`\nDone. ${live} live store(s), 1 awaiting approval, ${created.length} products, ${n} ratings, ${COUPONS.length} coupons.`)
    console.log('Sign in, then approve "Nova Tech" from /admin/approve to demo the approval flow.\n')
}

main()
    .catch(err => { console.error('\nSeed failed:', err.message, '\n'); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
