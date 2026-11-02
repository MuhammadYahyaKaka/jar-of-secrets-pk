# Jar of Secrets PK — Complete E-Commerce Website (Standalone Code)

A complete, working e-commerce store you can host yourself: storefront, cart,
Karachi-only checkout, Online Bank Transfer with payment-screenshot upload,
Cash on Delivery, order notifications logging, and a secure Admin Dashboard.

**Zero dependencies.** It runs on Node.js built-in modules only
(`http`, `fs`, `path`, `crypto`) — no `npm install` needed.

Theme matches the Jar of Secrets PK logo: soft blush pink (`#FDF2F3` / `#F4B8C1`)
with elegant gold (`#A8872A` / `#B9975B`), in a clean **sans-serif** font stack
(no external fonts, no CDN — nothing external can block the page from loading).

---

## How to run

```bash
node server.js
```

Then open:

- Store: http://localhost:3000
- Admin: http://localhost:3000/admin

Use a different port if needed: `PORT=8080 node server.js`

Requires Node.js 18+ (for the built-in `fetch` used by the WhatsApp API call).

---

## First-time Admin setup (important)

1. Open http://localhost:3000/admin
2. The **one-time setup form** appears — choose your own username and password
   (8+ characters). There is **no default password**, and the setup form
   permanently disappears once the first admin account exists.
3. Log in, then go to **Admin → Settings** and add your bank details BEFORE
   taking online-transfer orders (see below). Nothing is hardcoded.

---

## Architecture — how everything connects

```
Browser (customer) ──► public/index.html + app.js ──► REST API (server.js) ──► data/db.json
Browser (admin)    ──► public/admin.html + admin.js ─► REST API (Bearer token) ─┘
Payment screenshots ──► uploads/screenshots/  (private — NOT web-accessible)
On every order ──► WhatsApp Cloud API attempt + notificationLogs entries (independent)
```

- **server.js** — the entire backend: static file serving, REST API, admin
  authentication (scrypt password hashing + salt, server-side session tokens),
  server-side price/total recomputation, stock checks, idempotency keys,
  screenshot validation/storage, and notification dispatch/logging.
- **public/** — the frontend (plain HTML/CSS/JS, no build step, no CDN).
  The cart lives in `localStorage` via safe try/catch helpers with an
  in-memory fallback, so blocked browser storage never crashes the shop.
- **data/db.json** — the whole database as one JSON file, with collections for
  `products`, `customers`, `orders`, `payments`, `paymentScreenshots`,
  `adminUsers`, `websiteSettings` and `notificationLogs` (order items and
  product images are stored inline on their parent records; product images
  uploaded in Admin are stored as data URLs, up to 4 per product).
- **uploads/screenshots/** — payment screenshots saved as files. This folder is
  deliberately NOT served publicly; a screenshot can only be fetched through
  `GET /api/admin/orders/:id/screenshot` with a valid admin token.

## Folder structure

```
jar-of-secrets-code/
├── server.js              # backend (Node built-ins only)
├── package.json           # no dependencies; `npm start` also works
├── README.md
├── data/
│   └── db.json            # JSON database (seeded with 5 sample products)
├── uploads/
│   ├── screenshots/       # private payment screenshots (admin-only access)
│   └── products/          # reserved for product files if you extend it
└── public/
    ├── index.html         # storefront
    ├── app.js             # storefront logic (catalog, cart, checkout)
    ├── admin.html         # admin dashboard
    ├── admin.js           # admin logic
    └── styles.css         # blush-pink & gold theme, sans-serif
```

---

## Business rules built in

- **Karachi-only delivery.** The checkout city list is Karachi, Lahore,
  Islamabad, Rawalpindi, Faisalabad, Multan, Peshawar, Quetta, Hyderabad,
  Sialkot, Other. Any city other than Karachi is blocked (in the UI *and* on
  the server) with exactly:
  *"Sorry! We currently provide delivery services only within Karachi. Delivery to your selected city is not available."*
- **Online Bank Transfer:** bank details shown at checkout come from
  Admin → Settings (never hardcoded). A payment screenshot (JPG/JPEG/PNG/PDF,
  max 5 MB, with preview) is **required**, and the order starts as
  **Payment Verification Pending** — the admin verifies or rejects it manually.
- **Cash on Delivery:** no bank details, no screenshot; the order is marked
  **Cash on Delivery**.
- **Prices are never trusted from the browser.** Totals are recomputed on the
  server from database prices, stock is checked and reduced on order, and an
  idempotency key per checkout prevents duplicate orders (double clicks,
  retries).
- **Public APIs never expose secrets.** `/api/settings/public` returns only the
  store name, delivery city and fee. Bank details are only returned by the
  checkout-flow endpoint when a customer is paying. WhatsApp tokens and admin
  data are never sent to the storefront.

---

## Configuring Admin → Settings

All of these are managed in **Admin → Settings** — nothing is hardcoded:

| Setting | Used for |
|---|---|
| Bank Name / Account Title / Account Number / IBAN / Payment Instructions | Shown to customers who choose Online Bank Transfer |
| Admin WhatsApp Number | Where order notifications are sent (use country code, e.g. `92300xxxxxxx`) |
| WhatsApp Phone Number ID + API Token | Official Meta WhatsApp Cloud API credentials (below) |
| Gmail / Notification Email | Address order-notification emails are prepared for (below) |
| Delivery Fee | Added to every order total (seeded: PKR 250) |

### WhatsApp — official Meta WhatsApp Business Cloud API

1. Go to https://developers.facebook.com → create an app → add the
   **WhatsApp** product.
2. In *WhatsApp → API Setup*, note your **Phone Number ID** and generate an
   access token (use a permanent token via a System User for production).
3. Paste **Phone Number ID**, **token**, and your **admin WhatsApp number**
   into Admin → Settings and save.
4. Every new order then automatically sends the full order details (customer,
   items, totals, payment status, screenshot filename) to your WhatsApp.
   If the API is not configured or a send fails, the order still saves and the
   complete message is written to **Admin → Notifications** so nothing is lost.

### Gmail / email notifications

Every order also writes a complete email entry (full order body, addressed to
your configured notification email, with the screenshot reference) into
**Admin → Notifications**, independently of WhatsApp — so you can always read
every order there even if sending fails.

Automatic SMTP sending is intentionally **not** faked in this zero-dependency
build (Node's built-ins include no SMTP client). To enable real email sending,
pick one:

- Add `nodemailer` (`npm install nodemailer`) and send the logged email body
  using a Gmail **App Password** (Google Account → Security → 2-Step
  Verification → App passwords), or
- POST the logged body to a transactional email API (SendGrid, Resend,
  Amazon SES) from the `notifyOrder()` function in `server.js` — the complete
  body is already prepared there.

---

## Products & photos

The seed database includes 5 sample products. Their cards show emoji
placeholder visuals (💌 🕯️ 🎁 🗝️ 🫙) because no real product photos exist yet.
Upload real photos (up to 4 per product) in **Admin → Products** — they
immediately replace the placeholders on product cards and detail pages.

---

## Deployment notes

- **VPS (recommended for a real shop):** install Node.js 18+, copy this
  folder, run `node server.js` (or with a process manager:
  `npx pm2 start server.js --name jar-of-secrets` — or a systemd service), and
  put Nginx/Caddy in front as an HTTPS reverse proxy to port 3000. Point your
  domain (e.g. jarofsecrets.pk) DNS A record to the server.
- **Render / Railway style platforms:** create a Web Service from this folder,
  start command `node server.js`, and set the platform's `PORT` env (already
  respected). Note: on free/ephemeral tiers the filesystem may reset — attach
  a persistent disk/volume for `data/` and `uploads/`, or orders will be lost
  on redeploy.
- **Backups:** back up `data/db.json` and `uploads/screenshots/` regularly —
  together they are your entire shop's records.
- Keep the server behind HTTPS in production so admin logins and payment
  screenshots travel encrypted.

---

## Security notes

- Admin passwords are hashed with `crypto.scrypt` + per-user salt; there is no
  default password, only one-time first-run setup.
- All `/api/admin/*` endpoints (except setup/login/status) require a
  server-side session token (`Authorization: Bearer …`).
- Payment screenshots are validated by type and size (JPG/JPEG/PNG/PDF,
  ≤ 5 MB), stored outside the public folder, and only ever served to a
  logged-in admin.
- All customer inputs are validated on the server; Karachi-only delivery,
  stock and totals are enforced server-side, not just in the browser.
- Change your admin password discipline: use a strong unique password, and if
  you ever need to reset access, stop the server, remove the admin record from
  `data/db.json` (`adminUsers`), restart, and run setup again — do this only
  when no one else can access setup in that moment.
