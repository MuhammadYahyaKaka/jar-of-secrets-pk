# Jar of Secrets PK — Public Hosting Guide (asan alfaz me)

Localhost sirf aapke apne computer par chalta hai. Public chalane ka matlab hai:
website ek server par 24 ghante chale, aur har customer usay link se khol sake.
Us ke liye Node.js wali hosting chahiye. Sab se asan tareeqa: **Render**.

Is package me `render.yaml` file pehle se bani hui hai — Render usay parh kar
khud tamam settings laga deta hai. Aapko sirf neeche wale steps karne hain.

## Step 1 — Code GitHub par rakhein
1. github.com par muft account banayein (agar pehle se hai to login karein).
2. "New repository" banayein, naam rakhein: jar-of-secrets-pk
3. Is folder ki TAMAM files repository me upload kar dein
   (GitHub par "uploading an existing file" wala option hota hai —
   tamam files select karke daal dein, folders ke sath).

## Step 2 — Render par deploy karein
1. render.com par account banayein — "Sign up with GitHub" wala button
   istemal karein taake dono account jud jayein.
2. Render Dashboard me: **New → Blueprint** par click karein.
3. Apni `jar-of-secrets-pk` repository select karein.
4. Render khud `render.yaml` parh lega — bas **Apply / Create** kar dein.
5. Kuch minutes me website live ho jayegi. Link aisa hoga:
   `https://jar-of-secrets-pk.onrender.com`
   - Customers ke liye yahi link hai.
   - Aapke liye Admin: usi link ke aakhir me `/admin`

## Step 3 — Pehla Admin banayein (sirf ek baar)
1. Render me apni service kholein → **Logs** par click karein.
2. Wahan ek line hogi: "One-time setup code: ........"
   Wo code note kar lein (har nayi shuruaat par naya code banta hai,
   aur ek admin ban jane ke baad wo code kaam karna band kar deta hai).
3. Browser me `https://aapka-link.onrender.com/admin` kholein,
   wo code + apna username + mazboot password dein — admin tayyar.

## Step 4 — Settings bhar dein
Admin → Settings me ja kar ye bhar dein:
- Bank Name, Account Title, Account Number, IBAN, Payment Instructions
  (ye bharte hi checkout par Online Bank Transfer chalne lagega)
- WhatsApp Number aur Notification Email (Gmail)
- WhatsApp par khud message bhejne ke liye Meta ka Phone Number ID + Token
  (tafseel README.md me hai)

## Kharcha aur zaroori note
- Render ka **muft (Free) plan is website ke liye theek nahi**: website so
  jati hai, aur orders/screenshots wali disk muft plan par milti hi nahi —
  data udd sakta hai.
- **Starter plan** (takreeban $7/month) + chhoti si disk ke sath website
  hamesha chalegi aur tamam orders mehfooz rahenge. Asal business ke liye
  yahi rakhein.
- Railway bhi ek option hai: wahan bhi yahi code chalega, bas wahan
  ek Volume laga kar DATA_DIR aur UPLOADS_DIR us ki taraf rakhna hoga.

## Apna domain (chahen to)
`jarofsecrets.pk` jaisa domain le kar Render → Settings → Custom Domains
me jod sakti hain. Us ke baad link aapke apne naam ka hoga.
