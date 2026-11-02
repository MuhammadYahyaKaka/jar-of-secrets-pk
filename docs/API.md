# Jar of Secrets PK — API contract

One backend (`server.js`), one database (SQLite, `DATA_DIR/store.sqlite`). The storefront
(`public/index.html` + `public/store.js`) and Admin (`public/admin.html` + `public/admin.js`)
both use only these endpoints.

Conventions: JSON request and response bodies. Errors are `{ "error": "<human message>", "code": "<CODE>" }`.
All `/api/*` responses send `Cache-Control: no-store`. Money is whole PKR integers.

## Status vocabularies (exact strings)

- `orderStatus`: `Pending`, `Confirmed`, `Processing`, `Shipped`, `Delivered`, `Cancelled`
- `paymentStatus`: `Unpaid`, `Pending Verification`, `Paid`, `Rejected`, `Refunded`
- `paymentMethod`: `cod`, `online`

Initial values: COD → `Pending` / `Unpaid`. Online → `Pending` / `Pending Verification`.
Uploading a screenshot NEVER sets `Paid`; only an admin action can.

COD orders may only hold `Unpaid`, `Paid`, `Refunded`. Online orders may hold any payment status.

## Public endpoints (no auth)

### `GET /api/products`
`{ "products": [Product] }` — enabled products only.

```
Product = {
  id, name, price, category, shortDescription, description,
  specifications,            // string; one "Key: Value" per line is rendered as a table row.
                             // A line without ": " is a single-cell row.
  stock,                     // integer >= 0
  emoji,
  art: { kind: "jar"|"candle"|"box"|"ring", color: "#RRGGBB"|null, label: string|null } | null,
                             // placeholder artwork used when images is empty
  images: [url],             // e.g. "/uploads/products/<32hex>.jpg", relative to the API base
  updatedAt                  // ISO string
}
```

### `GET /api/settings/public`
`{ storeName, deliveryCity, deliveryFee, cities: [string], onlinePaymentAvailable: bool }`
`onlinePaymentAvailable` is true only if bank name, account title and account number are all set.
`cities` always contains `deliveryCity`.

### `GET /api/checkout/bank-details`
`{ configured: bool, bankName, bankAccountTitle, bankAccountNumber, bankIban, paymentInstructions }`
Unset values are empty strings, never placeholder text.

### `POST /api/orders`
Request:
```
{
  customer: { name, mobile, whatsapp, email, address, city },
  items: [{ productId, quantity }],
  paymentMethod: "cod" | "online",
  screenshot: { name, mime, data /* base64, optional data: prefix */ } | null,
  idempotencyKey: string   // 8–100 chars, required
}
```
Any other field (`price`, `total`, `subtotal`, `deliveryFee`, `paymentStatus`, ...) is ignored; all
money values are recomputed from the database.

Validation (all server-side):
- name 2–100 chars; mobile and whatsapp 10–15 digits after stripping `+ - ( ) space`; email is a
  plausible address ≤ 254 chars; address 8–500 chars; city must be in `cities`.
- quantity must be an integer 1–100; anything else is rejected, never coerced. Duplicate lines for a
  product are merged before stock is checked.
- at most 50 distinct items.

Responses:
- `201 { "order": PublicOrder }`
- `200 { "order": PublicOrder, "duplicate": true }` when the idempotency key was already used
  (no second order, no second stock deduction).
- Errors: `400 VALIDATION`, `400 EMPTY_CART`, `400 SCREENSHOT_REQUIRED`, `400 SCREENSHOT_INVALID`,
  `409 PRODUCT_UNAVAILABLE`, `409 OUT_OF_STOCK`, `409 ONLINE_PAYMENT_UNAVAILABLE`,
  `413 TOO_LARGE`, `422 CITY_NOT_SERVED`, `429 RATE_LIMITED`.

`CITY_NOT_SERVED` message: `Sorry! We currently provide delivery services only within <deliveryCity>. Delivery to your selected city is not available.`

```
PublicOrder = {
  id, customer: { name, mobile, whatsapp, email, address, city },
  items: [{ productId, name, price, quantity, lineTotal }],
  subtotal, deliveryFee, total, paymentMethod, paymentStatus, orderStatus, createdAt
}
```

Screenshot rules: required for `online`, ignored for `cod`. JPG, PNG or PDF, ≤ 5 MB decoded. The
type is determined from the file's magic bytes; the client's `mime` and filename are not trusted.
Stored outside `public/`, under a random name, reachable only through the admin endpoint.

### `GET /uploads/products/<32hex>.(jpg|png|webp)`
Public product image. `uploads/screenshots/*` is never served by any public route.

## Admin auth

- `GET /api/admin/status` → `{ needsSetup, hasAdmin }`
- `POST /api/admin/setup` `{ username, password, setupCode }` → `201 { token, username }`.
  Works only while no admin exists. `setupCode` is a one-time code printed to the server console at
  startup. Wrong or missing code → `403 BAD_SETUP_CODE`; admin already exists → `403 SETUP_COMPLETE`.
  Username 3+ chars, password 8+ chars → otherwise `400 VALIDATION`.
- `POST /api/admin/login` `{ username, password }` → `200 { token, username }`; `401 BAD_LOGIN`;
  `429 RATE_LIMITED` after repeated failures from an IP.
- `POST /api/admin/logout` → `{ ok: true }`

Every other `/api/admin/*` route requires `Authorization: Bearer <token>`, otherwise
`401 AUTH_REQUIRED`. Sessions survive a server restart (only a hash of the token is stored) and expire
after 12 hours of inactivity.

## Admin endpoints

### `GET /api/admin/sync`
Lightweight poll target; Admin calls it every few seconds.
`{ revision, latestOrderId, stats: Stats }` — `revision` is an integer that increases on every write
to products, orders or settings. Re-fetch lists only when it changes.

### `GET /api/admin/stats` → `{ stats: Stats }`
```
Stats = {
  products, activeProducts, lowStock,      // lowStock: enabled products with stock <= 5
  orders, pending, confirmed, processing, shipped, completed, cancelled,
                                           // completed = Delivered
  totalSales,                              // sum of total, excluding Cancelled orders and
                                           // Rejected/Refunded payments
  paidSales,                               // sum of total where paymentStatus = Paid
  pendingVerification
}
```

### Products
- `GET /api/admin/products` → `{ products: [AdminProduct] }` — Product plus `enabled`, `createdAt`. Includes disabled.
- `POST /api/admin/products` → `201 { product }`
- `PUT /api/admin/products/:id` → `200 { product }` (partial update allowed; only sent fields change)
- `DELETE /api/admin/products/:id` → `{ ok: true }`. Past orders keep their item snapshot.

Body fields: `name` (required on create, 1–120 chars), `price` (integer ≥ 1), `stock` (integer ≥ 0),
`category`, `shortDescription`, `description`, `specifications`, `emoji`,
`art` (`{kind,color,label}` as above, or null), `enabled` (bool), and `images`.

`images` is the complete desired list, max 4. Each entry is either an existing
`/uploads/products/...` URL (kept) or a `data:image/(jpeg|png|webp);base64,...` URL (validated by magic
bytes, ≤ 5 MB, written to `uploads/products/` under a random name). Anything else, including SVG, →
`400 VALIDATION`. Files no longer referenced by a product or an order item are removed.

### Orders
- `GET /api/admin/orders?status=&paymentStatus=&q=&limit=` → `{ orders: [AdminOrder], total }`, newest
  first. `q` searches id, customer name, mobile, email. Default limit 200, max 1000. `total` is the
  number matching before the limit. List entries omit `history`.
- `GET /api/admin/orders/:id` → `{ order: AdminOrder }` with `history`.
- `GET /api/admin/orders/:id/screenshot` → the file, with its validated Content-Type.
- `PATCH /api/admin/orders/:id` `{ orderStatus?, paymentStatus?, paymentAction?: "verify"|"reject", note? }`
  → `{ order: AdminOrder }` with `history`. `verify` = `Paid`, `reject` = `Rejected`; both online only.

Rules: unknown status → `400 VALIDATION`; a payment status not allowed for the method → `400 VALIDATION`.
Moving an order to `Cancelled` restores its stock exactly once. Moving it out of `Cancelled` deducts
stock again, and fails with `409 OUT_OF_STOCK` if there is not enough. Every change appends a history
entry; a no-op appends nothing.

```
AdminOrder = {
  id, customerId,
  customer: { name, mobile, whatsapp, email, address, city },
  items: [{ productId, name, price, quantity, lineTotal, image }],
  subtotal, deliveryFee, total, paymentMethod, paymentStatus, orderStatus,
  screenshot: { mime, size, originalName, createdAt } | null,
  createdAt, updatedAt,
  history: [{ at, field: "created"|"orderStatus"|"paymentStatus", from, to, note, actor }]
}
```

### Customers
`GET /api/admin/customers?q=` → `{ customers: [{ id, name, mobile, whatsapp, email, address, city,
orderCount, totalSpent, firstOrderAt, lastOrderAt }] }`, most recent first. One customer per normalised
mobile number. Each order keeps its own snapshot of the details given at checkout. `totalSpent` uses the
same exclusions as `totalSales`.

### Settings
- `GET /api/admin/settings` → `{ settings }`: `storeName, deliveryCity, deliveryFee, bankName,
  bankAccountTitle, bankAccountNumber, bankIban, paymentInstructions, whatsappNumber,
  whatsappPhoneNumberId, notificationEmail, whatsappApiToken: "", whatsappApiTokenSet: bool`.
  The stored token is never returned.
- `PUT /api/admin/settings` (partial). A blank `whatsappApiToken` keeps the stored one. `deliveryFee`
  is an integer ≥ 0, otherwise `400 VALIDATION`.

### Notifications
`GET /api/admin/notifications` → `{ notifications: [{ id, orderId, channel, to, subject, body, status, error, createdAt }] }`, newest first, max 200.

## Runtime configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `./data` | Holds `store.sqlite`; legacy `db.json` is read from here |
| `UPLOADS_DIR` | `./uploads` | `products/` and `screenshots/` |
| `ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call the PUBLIC API cross-origin. Never applies to `/api/admin/*`. |
| `TRUST_PROXY` | off | `1` = take the client IP from `X-Forwarded-For` (set this behind Nginx/Caddy/Render) |
