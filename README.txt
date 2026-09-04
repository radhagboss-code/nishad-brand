NISHAD BRAND — PostgreSQL-ready

WHAT CHANGED
- Orders and ID inventory are stored in PostgreSQL instead of server memory.
- IDs remain available after Render restarts/redeploys when PostgreSQL is connected.
- Payment approval assigns IDs inside a database transaction so the same ID is not assigned twice.
- Passwords are encrypted before being stored in PostgreSQL using AES-256-GCM.
- QR image is included at public/qr.jpg.

RENDER SETUP (REQUIRED)
1. In Render Dashboard click + New > Postgres and create a database.
2. Use the same region as the NISHAD BRAND web service.
3. Open the database and use Connect > Internal Database URL.
4. Open the NISHAD BRAND web service > Environment.
5. Add these environment variables:
   DATABASE_URL = <Render Postgres Internal Database URL>
   ADMIN_SECRET = <a strong secret of your choice>
   CREDENTIAL_ENCRYPTION_KEY = <a long random secret; keep it safe>
6. Save and deploy the web service.
7. After deploy, open:
   https://YOUR-SERVICE.onrender.com/api/health/db
   It should show database connected.
8. Open /inventory.html and add Username + Password records.
9. Test a purchase and approve the UTR from /admin.html.

IMPORTANT
- Never put DATABASE_URL, ADMIN_SECRET, or CREDENTIAL_ENCRYPTION_KEY into GitHub files.
- Keep CREDENTIAL_ENCRYPTION_KEY permanently. If it is changed later, old encrypted passwords cannot be decrypted.
- Render Free Postgres is suitable for testing but currently expires after 30 days. Upgrade the database for long-term production storage.
- The existing in-memory data from older deployments cannot be automatically recovered; add your IDs again to the new database.


RATE CONTROL:
Admin panel now has an ID Price section. Enter a custom integer price or use ₹300/₹350/₹400, then Save Rate. New orders use the current saved rate; existing orders keep their original amount.
