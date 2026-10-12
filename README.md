# SMART RIDE — Calabar pilot MVP (Version 8: Web Push Notifications + Login Session Fix)

SMART RIDE is a separate ride-hailing web app configured to start in **Calabar, Cross River State, Nigeria**. It supports cars, motorcycles, tricycles, and delivery vehicles. Its business model is driver subscriptions plus a commission on completed trips.

This is a testable MVP, **not yet a production-ready Bolt replacement**. Before carrying real passengers, complete operational, legal, insurance, safety, privacy, security, payment, and load testing.

## What's included

- Customer registration/login and ride history.
- Map-based pickup and destination selection centred on Calabar.
- Reverse address lookup using OpenStreetMap/Nominatim.
- Route distance and duration estimates through the public OSRM routing service.
- Server-side route calculation and fare estimates by vehicle category.
- Customer can choose cash or Paystack checkout.
- Paystack checkout is configured to offer **card, USSD, and bank transfer**. The customer's ride is not released to drivers until a successful payment is verified server-side.
- Paystack server-side transaction verification checks transaction status, currency, and amount before updating the ride.
- Paystack webhook endpoint with signature verification for delayed payment confirmations.
- Approved drivers can pay subscriptions through Paystack; subscriptions activate after verified payment.
- Driver application and login, administrator approval, and online/offline controls.
- Ride matching by vehicle category and atomic ride acceptance.
- Driver trip status: accepted, arrived, in progress, completed.
- Drivers can share browser GPS location. Customers can view an assigned driver's latest reported location on their ride dashboard; the customer view refreshes every five seconds while an active trip is shown.
- Driver subscription + commission business model, dashboard, admin controls, MongoDB persistence, health endpoint, and admin promotion script.
- Financial ledger for each completed ride, separating driver earnings payable by SMART RIDE from cash commissions owed by drivers.
- Manual driver payout recording: transfer earnings yourself, then record the bank reference in the administrator dashboard.
- Smart Lock security bot: when accepting a cash ride, drivers must acknowledge the commission rule; when they complete the ride and confirm receiving the cash, a server-side 24-hour commission timer begins.
- Driver dashboard countdowns and Paystack checkout for paying cash-ride commissions (card, USSD, or bank transfer where enabled).
- Automatic overdue checks run periodically and during protected driver actions. An overdue unpaid commission locks the driver from going online or accepting new rides.
- After the commission payment is verified (Paystack) or manually confirmed by an administrator (external transfer), the driver remains locked until an administrator separately approves unlocking. The app records payment references and administrator actions.

## Current limits — read before real use

- Public OpenStreetMap tiles, Nominatim, and OSRM services can rate-limit or change availability. They are useful for prototyping, not a guaranteed commercial SLA. A production launch should use a suitable contracted map/routing provider and follow its terms.
- Browser GPS requires permission and a secure HTTPS page. Drivers must tap **Share live location** and keep the driver page open. This is not background tracking and location can stop when the browser/device sleeps or loses signal.
- Route distance and fare are estimates. Initial fare defaults are Car Standard ₦800 + ₦250/km; Car Comfort ₦1,200 + ₦350/km; Car XL ₦1,500 + ₦400/km; Motorcycle ₦300 + ₦100/km; Tricycle ₦500 + ₦150/km; Delivery ₦500 + ₦180/km. These are starter examples and need business validation. The final fare can still be entered by the driver when completing a trip.
- This implementation does not automatically split/transmit ride proceeds to drivers, send driver payouts, or issue refunds. Paystack payments are collected to the SMART RIDE merchant account. Driver earnings are recorded in the ledger; the administrator must transfer them manually and record the bank reference. Smart Lock is an application-level restriction, not a substitute for a formal debt collection process or legal advice.
- Paystack channels depend on your merchant account eligibility and settings. Enable card, USSD, and bank transfer in the Paystack Dashboard where available.
- Paystack callback and webhook processing are implemented, but you must configure the webhook URL and test with Paystack test credentials before going live.
- Web Push notifications are included in V8 when VAPID keys are configured; SMS, chat/calling, SOS dispatch centre, document verification, insurance integration, automated refunds, and 24/7 operations are not included. Customer star ratings are included in this version.
- Customer driver ratings: customers can submit one 1–5 star rating (with optional feedback) for each completed ride; the driver dashboard shows average rating and count. Ratings are tied to the customer’s own completed ride and cannot be submitted repeatedly for the same ride.
- Installable Progressive Web App (PWA): manifest, icons, service worker, offline fallback, and browser install prompt/help for supported Android/desktop browsers and iOS Safari Add to Home Screen. The service worker caches only static assets and the offline page; authenticated pages, customer/driver records, APIs, and payment routes are deliberately not cached.
- This PWA can be installed from a supported browser on HTTPS. It is not yet a native Play Store, Apple App Store, or Microsoft Store release; store distribution would require separate packaging, testing, and store accounts/processes.
- Driver and customer forms do not replace identity checks, vehicle inspection, driving licence validation, insurance, or local regulatory compliance.

## Ratings and installation

- After a ride is marked completed, the customer can rate the assigned driver from their customer dashboard. A ride can be rated only once by its customer, from 1 to 5 stars; a short comment is optional.
- The driver dashboard displays the aggregate average and number of ratings. The app recalculates the aggregate from completed rides after a rating is submitted.
- Deploy to an HTTPS Render URL. Open SMART RIDE in Chrome/Edge and choose the browser’s Install app option when shown. On Android Chrome, use the menu (⋮) and choose Install app or Add to Home screen. On iPhone/iPad, open the site in Safari, tap Share, then Add to Home Screen.
- PWA offline support is limited to static resources and an offline information page. Booking, login, driver controls, payments, and private dashboard data require a network connection.

## Requirements

- Node.js 18 or newer (uses built-in `fetch`).
- MongoDB Atlas or another MongoDB deployment.
- Render Web Service.
- A Paystack merchant account eligible for the desired payment channels.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI`, `MONGODB_DB`, a long random `SESSION_SECRET`, and `APP_BASE_URL` (for local testing, `http://localhost:3000`).
3. Set `PAYSTACK_SECRET_KEY` to your **Paystack test secret key** while testing. Never put a secret key in browser JavaScript or commit `.env` to GitHub.
4. Install dependencies with `npm install`.
5. Run `npm start` and open `http://localhost:3000`.
6. Register your own customer account.
7. Promote your account to admin by running `npm run make-admin -- your-registered-email@example.com` from this project folder. Log out and back in. Never grant admin to another person unless you intend to.
8. Test the booking map with points inside Calabar, cash bookings, and Paystack test checkout before trying driver flows.

## Deploy to Render

1. Back up the MongoDB database before updating an existing deployment.
2. Upload the contents of this folder to your private SMART RIDE GitHub repository.
3. In Render, create/update a Web Service. Build command: `npm install`; start command: `npm start`.
4. Set environment variables in Render:
   - `MONGODB_URI` — your MongoDB Atlas connection string
   - `MONGODB_DB` — `smart_ride`
   - `SESSION_SECRET` — a long, unique random secret
   - `NODE_ENV` — `production`
   - `APP_BASE_URL` — the full HTTPS address of your deployed SMART RIDE service, without a trailing slash
   - `PAYSTACK_SECRET_KEY` — use the Paystack test secret key first; replace with live secret only after successful testing and account approval
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — required only if drivers upload profile photos; set these to your Cloudinary account values
5. In the Paystack Dashboard, set the webhook URL to `https://YOUR-SMART-RIDE-DOMAIN/payments/paystack/webhook`. Use your actual Render/custom domain.
6. Ensure card, USSD, and bank transfer are enabled for your merchant account where available.
7. Deploy, then test `/health`, registration/login, map selection, cash booking, Paystack test payment, webhook delivery, driver approval, subscription payment, and live-location sharing.
8. To promote your account to admin, run the admin promotion script from a trusted computer with the same MongoDB connection string, or update only your own user's `role` to `admin` in MongoDB Atlas Data Explorer.

Do not commit `.env`, Paystack keys, or database credentials to GitHub. A free hosting tier may sleep and is not suitable for reliable real-time ride operations. Keep Paystack in test mode until the full payment and webhook flow has been tested.

## Smart Lock cash-commission policy

1. The driver must acknowledge the policy before accepting a cash-payment ride.
2. The 24-hour countdown starts only when the driver completes the trip and explicitly confirms receiving the cash fare. This avoids starting the timer before the driver has actually collected the money.
3. The ledger records the commission due and its deadline in MongoDB; the countdown is not based only on the browser clock.
4. If the commission remains unpaid after the deadline, Smart Lock marks the driver account locked and takes the driver offline. New rides and going online are blocked. Existing trip status updates are not forcibly blocked, to avoid leaving a passenger stranded.
5. The driver can pay the commission through Paystack. A successful verified payment changes the case to `paid_pending_admin`; a manual bank-transfer receipt can also be recorded by an administrator.
6. A separate administrator action is required to approve unlocking. The unlock is refused if any overdue cash commission remains unpaid.
7. The background worker checks about once per minute; protected driver actions also run an overdue check, so the lock is enforced when the driver next attempts a protected action.

**Test this in Paystack test mode first.** The admin manual-confirm action assumes the administrator has independently checked the bank statement. Do not record a payment based only on a driver's claim or screenshot.

## Starter business defaults

- Launch service area: Calabar, Nigeria.
- Default commission: 15% of recorded completed fare.
- Default driver subscription: ₦5,000 for 30 days.
- Fare defaults are described above and can be adjusted in code/config in this MVP; the admin dashboard currently controls commission and subscription pricing/duration.

These are prototype defaults, not legal, tax, or market-pricing advice.

## Paystack references

- [Paystack Accept Payments documentation](https://paystack.com/docs/payments/accept-payments/)
- [Paystack Verify Payments documentation](https://paystack.com/docs/payments/verify-payments/)
- [Paystack Payment Channels documentation](https://paystack.com/docs/payments/payment-channels/)


## V7: Driver profiles and ride acceptance notifications
- Driver applications accept an optional profile photo (JPEG/PNG/WebP up to 4 MB) and require vehicle colour plus make/model. Photo uploads require Cloudinary environment variables.
- When a driver accepts a ride, the customer receives an in-app dashboard notification and can enable browser notifications. The dashboard polls for updates while open.
- Customer ride rows show driver photo, phone, vehicle make/model, colour, plate number, current rating and rating count, and completed-ride count.
- Driver dashboard displays the profile photo and completed ride count calculated from completed ride records.
- Browser notifications require permission and supported browser/device settings. Push notifications when the browser is fully closed are not included in this polling-based release.


## V8: Web Push notifications for customers and drivers

- Customers can enable browser push notifications and receive an alert when their assigned driver accepts a ride, even when the site is backgrounded or closed (subject to browser/device support and notification permissions).
- Online, approved, subscribed, non-locked drivers with a compatible vehicle category can receive a push alert when a new cash ride is created or a Paystack ride is verified and released to dispatch.
- Push subscriptions are stored in MongoDB per signed-in user and device. Invalid/expired browser subscriptions (HTTP 404/410 from push services) are automatically removed.
- Notifications open the relevant dashboard. The server never sends ride or customer data to unauthenticated endpoints.
- Push delivery requires VAPID keys and HTTPS. If VAPID keys are absent, the app remains usable but push notifications are unavailable; the UI displays that configuration is missing. Browser push delivery is best-effort and depends on browser/device support, battery/network conditions, and push-service availability.

### Configure Web Push on Render

1. Generate a VAPID key pair on a trusted computer. After installing dependencies, run `npx web-push generate-vapid-keys`. Keep the private key secret.
2. In Render Environment, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (for example, `mailto:your-real-admin-email@example.com`). Do not commit the private key to GitHub.
3. Deploy the app over HTTPS.
4. Sign in separately on a customer device and a driver device, then click **Enable push notifications** and allow browser notifications on each device. The driver must be approved, subscribed, unlocked, online, and have a compatible vehicle to receive new-ride alerts.
5. Test with a cash ride first, then a Paystack test ride. To test the customer alert, have a driver accept a ride and confirm that the customer device receives a notification.

Push notifications are not guaranteed delivery: users may disable notifications, browsers may delay them, and some iOS/browser configurations require the site to be installed to the home screen. Keep the dashboard's in-app updates as a fallback.


### Login session fix for Render
This build trusts Render's HTTPS reverse proxy and uses automatic secure-cookie detection. This fixes the common redirect loop where login succeeds but the browser returns to `/login` because the session cookie was not accepted. After deploying, verify that the first login response sets a `connect.sid` cookie; do not share the cookie value.


## Administrator login and 2FA (v1.7)
1. In Render, open your SMART RIDE web service → Environment. Add `ADMIN_EMAIL` with the exact email address you personally use to sign in. Do not put your password or authenticator code in Render.
2. Keep your existing `MONGODB_URI`, `MONGODB_DB`, and other working environment variables unchanged. Set `SESSION_SECRET` to a long random secret if it is not already set.
3. Register a SMART RIDE account using the same email as `ADMIN_EMAIL` if you have not already registered. Deploy/restart the service. The server will assign the admin role to that matching account; no manual MongoDB editing is needed.
4. Log in with your normal email and password. The first administrator login will show a QR code. Scan it in Google Authenticator or Microsoft Authenticator and enter the six-digit code.
5. After setup, every administrator login requires the password and a fresh six-digit authenticator code. Use the `/admin` page after successful verification.
6. If an existing session is stuck, log out, close the tab, reopen the site, and sign in again. Session writes are now saved before redirects.

Security note: set `ADMIN_EMAIL` only to an email account you control. Anyone able to log in to that exact account with its password could claim the configured administrator role, so protect that email and password. Keep the authenticator app backed up securely.


## Customer address entry and profile photos (V10 update)
- On the Book a Ride page, customers can either type a pickup/destination address and leave the field to locate it on the map, or tap the map to select both points. The app then requests a route estimate. Address lookup is limited to the Calabar pilot area.
- Signed-in customers can open **My profile** to update their name/phone and upload a profile picture (JPEG, PNG, WebP, maximum 4 MB).
- Profile photo storage uses Cloudinary. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in Render to enable photo uploads. Existing rides and MongoDB data are not deleted by this code update.
- Map tiles, address lookup and routing use public OpenStreetMap/Nominatim/OSRM services; service availability and address accuracy may vary.
