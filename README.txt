# NISHAD BRAND — Static QR + Manual Verification + ID Inventory

Features:
- ₹350 per ID
- Customer selects quantity
- Static QR payment
- Customer submits UTR
- Admin manually verifies payment
- Admin approves/rejects
- Admin can manually add Username + Password IDs
- On approval, requested number of AVAILABLE IDs are atomically assigned and marked SOLD
- Stock count can be used to show available IDs / out of stock
- Admin inventory page: `/inventory.html`
- Admin payment requests: `/admin.html`

Setup:
1. Install Node.js.
2. `npm install`
3. Set `ADMIN_SECRET` to a strong secret.
4. `npm start`
5. Customer: `/`
6. Admin payments: `/admin.html`
7. Admin inventory: `/inventory.html`

IMPORTANT:
This demo stores orders/inventory in memory, so data is lost on server restart. Before public use, use a real database, HTTPS, proper admin login, rate limiting, backups and audit logs.
