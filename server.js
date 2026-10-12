require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const webpush = require("web-push");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 }, fileFilter: (req,file,cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)) });

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "smart_ride";
let db;

app.disable("x-powered-by");
// Render terminates HTTPS at its proxy. Trust the proxy so express-session
// can correctly issue secure cookies for the original HTTPS request.
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true, limit: "20kb" }));
app.use(express.json({verify:(req,res,buf)=>{if(req.originalUrl==="/payments/paystack/webhook") req.rawBody=Buffer.from(buf);}}));
app.use(express.static("public"));
app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-before-deployment",
  resave: false, saveUninitialized: false,
  store: MONGO_URI ? MongoStore.create({ mongoUrl: MONGO_URI, dbName: DB_NAME }) : undefined,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" ? "auto" : false, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@smartride.example", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
async function sendPushToUser(userId, payload) {
  if (!db || !pushConfigured || !userId) return {sent:0,disabled:!pushConfigured};
  const rows = await db.collection("pushSubscriptions").find({userId:String(userId)}).toArray();
  let sent=0;
  for (const row of rows) {
    try { await webpush.sendNotification(row.subscription, JSON.stringify(payload)); sent++; }
    catch (e) {
      const status=Number(e.statusCode||0);
      if (status===404 || status===410) await db.collection("pushSubscriptions").deleteOne({_id:row._id});
      else console.error("Web push delivery failed:", status || e.message);
    }
  }
  return {sent,disabled:false};
}
async function notifyEligibleDriversOfRide(rideId) {
  if (!db || !pushConfigured) return;
  const ride=await db.collection("rides").findOne({_id:rideId,status:"requested",driverId:null});
  if (!ride) return;
  const now=new Date();
  const drivers=await db.collection("driverApplications").find({status:"approved",isOnline:true,smartLockStatus:{$ne:"locked"},subscriptionStatus:"active",subscriptionExpiresAt:{$gt:now}}).toArray();
  const recipients=drivers.filter(d=>rideCompatible(ride.rideType,d.vehicleType));
  await Promise.all(recipients.map(d=>sendPushToUser(String(d._id),{
    title:"New SMART RIDE request",
    body:`${ride.rideType||"Ride"}: ${ride.pickup} to ${ride.destination}. Estimated fare ₦${Number(ride.fareEstimateNGN||0).toLocaleString("en-NG")}. Open the driver dashboard to review.`,
    url:"/driver/dashboard", tag:`new-ride-${String(ride._id)}`, data:{rideId:String(ride._id),type:"new_ride"}
  })));
}

function page(title, body, user) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#087e68"><meta name="description" content="SMART RIDE — book rides and connect with drivers in Calabar, Nigeria."><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/icon-192.png" type="image/png"><link rel="apple-touch-icon" href="/icons/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><title>${title} | Smart Ride</title><link rel="stylesheet" href="/style.css"><script defer src="/pwa.js"></script></head><body><header><a class="brand" href="/">SMART RIDE</a><nav><a href="/">Home</a><a href="/book">Book a ride</a><a href="/driver">Drive with us</a>${user ? (user.role==='driver' ? '<a href="/driver/dashboard">Driver dashboard</a>' : '<a href="/dashboard">Dashboard</a><a href="/profile">My profile</a>') + '<form class="inline" method="post" action="/logout"><button class="navbtn">Log out</button></form>' : '<a href="/login">Log in</a><a href="/register">Sign up</a><a href="/driver/login">Driver login</a>'}</nav></header><div id="install-banner" class="install-banner" hidden><span>Install SMART RIDE on your device for quick access.</span><button type="button" id="install-app" class="button">Install app</button><button type="button" id="dismiss-install" class="navbtn" aria-label="Dismiss install prompt">Not now</button></div>${user && ["customer","driver"].includes(user.role) ? '<section class="push-setup" aria-live="polite"><span id="push-status">Enable notifications to receive ride updates even when SMART RIDE is not open.</span><button type="button" id="enable-push" class="button secondary">Enable push notifications</button></section><script defer src="/push.js"></script>' : ''}<main>${body}</main><footer>Smart Ride · Calabar pilot · Maps, route estimates and Paystack checkout enabled; test before real rides.</footer></body></html>`;
}
function currentUser(req) { return req.session.user || null; }
function requireLogin(req, res, next) { if (!currentUser(req)) return res.redirect("/login"); next(); }
function escapeHtml(s="") { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function notice(msg, type="info") { return `<div class="notice ${type}">${escapeHtml(msg)}</div>`; }
async function getSetting(key, fallback) { if (!db) return fallback; const doc = await db.collection("settings").findOne({_id:key}); return doc ? doc.value : fallback; }
function paystackReady() { return !!process.env.PAYSTACK_SECRET_KEY; }
async function paystackRequest(path, method="GET", payload) {
  if (!paystackReady()) throw new Error("Paystack is not configured. Add PAYSTACK_SECRET_KEY in Render environment variables.");
  const response=await fetch(`https://api.paystack.co${path}`,{method,headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,"Content-Type":"application/json"},...(payload?{body:JSON.stringify(payload)}:{})});
  const data=await response.json();
  if(!response.ok || !data.status) throw new Error(data.message || "Paystack request failed.");
  return data.data;
}
async function getRouteInfo(fromLat,fromLng,toLat,toLng) {
  for (const n of [fromLat,fromLng,toLat,toLng]) if(!Number.isFinite(Number(n))) throw new Error("Select pickup and destination on the map.");
  // Calabar service-area guard; expand only after SMART RIDE opens more cities.
  const valid=(lat,lng)=>lat>=4.8&&lat<=5.25&&lng>=8.15&&lng<=8.55;
  if(!valid(fromLat,fromLng)||!valid(toLat,toLng)) throw new Error("For now, SMART RIDE only accepts map points within the Calabar service area.");
  const url=`https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
  const r=await fetch(url,{headers:{"User-Agent":"SmartRide/1.0 (Calabar ride booking)"}});
  if(!r.ok) throw new Error("The route service is temporarily unavailable. Please try again.");
  const data=await r.json();
  if(data.code!=="Ok"||!data.routes?.length) throw new Error("Could not calculate a route for those points.");
  return {distanceKm:Math.max(0.5, data.routes[0].distance/1000),durationMins:Math.max(1,Math.round(data.routes[0].duration/60))};
}
function fareCategory(rideType="Car - Standard") {
  const t=String(rideType).toLowerCase();
  if(t.includes("motorcycle")) return "motorcycle";
  if(t.includes("tricycle")) return "tricycle";
  if(t.includes("delivery")) return "delivery";
  if(t.includes("comfort")) return "carComfort";
  if(t.includes("xl")) return "carXL";
  return "car";
}
async function estimateFare(rideType, distanceKm) {
  const category=fareCategory(rideType);
  const defaults={car:{base:800,perKm:250},carComfort:{base:1200,perKm:350},carXL:{base:1500,perKm:400},motorcycle:{base:300,perKm:100},tricycle:{base:500,perKm:150},delivery:{base:500,perKm:180}};
  const base=Number(await getSetting(`fare_${category}_base`,defaults[category].base));
  const perKm=Number(await getSetting(`fare_${category}_perKm`,defaults[category].perKm));
  return Math.max(500,Math.round(base+distanceKm*perKm));
}
function appBaseUrl(req) { return (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/,""); }
function uploadDriverPhoto(buffer) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return Promise.reject(new Error("Driver photo upload requires Cloudinary credentials. Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Render."));
  }
  return new Promise((resolve,reject) => {
    const stream=cloudinary.uploader.upload_stream({folder:"smart-ride/profile-photos",resource_type:"image",transformation:[{width:600,height:600,crop:"limit"}]},(error,result)=>error?reject(error):resolve(result.secure_url));
    stream.end(buffer);
  });
}


app.get("/", (req,res) => res.send(page("Ride booking", `
<section class="hero"><div><span class="eyebrow">YOUR CITY. YOUR RIDE.</span><h1>Move smarter with <em>Smart Ride.</em></h1><p>Request a ride, connect with a driver, and keep your trip details in one place.</p><a class="button" href="/book">Book a ride</a> <a class="button secondary" href="/driver">Become a driver</a></div><div class="hero-card"><div class="map-art"><span class="pin">●</span><span class="road"></span><span class="pin second">●</span></div><h3>Your next trip starts here</h3><p>Simple booking · Clear trip status · Local service</p></div></section>
<section class="cards"><article><h3>Easy booking</h3><p>Enter pickup and destination details to request a trip.</p></article><article><h3>Verified drivers</h3><p>Driver applications can be reviewed by the administrator.</p></article><article><h3>Transparent records</h3><p>Keep a record of trip status and payment method.</p></article></section>
<section class="notice">Launching in Calabar, Cross River State. Cars, motorcycles, tricycles, and delivery vehicles are supported. Map-based booking, route estimates, driver GPS sharing, and Paystack checkout are included in this pilot; test thoroughly before real passenger trips.</section>
`, currentUser(req))));

app.get("/register", (req,res) => res.send(page("Create account", `<section class="form-card"><h1>Create your account</h1><form method="post" action="/register"><label>Full name<input name="name" required maxlength="100"></label><label>Email<input type="email" name="email" required maxlength="160"></label><label>Phone number<input name="phone" required maxlength="40"></label><label>Password<input type="password" name="password" required minlength="8"></label><button class="button">Create account</button></form><p>Already registered? <a href="/login">Log in</a></p></section>`, currentUser(req))));
app.post("/register", async (req,res) => {
  try {
    const name=(req.body.name||"").trim(), email=(req.body.email||"").trim().toLowerCase(), phone=(req.body.phone||"").trim(), password=req.body.password||"";
    if (!name || !email || !phone || password.length < 8) return res.status(400).send(page("Register",notice("Enter all details and use a password of at least 8 characters.","error"),null));
    if (!db) return res.status(503).send(page("Unavailable",notice("Database is not configured. Set MONGODB_URI in Render environment variables.","error"),null));
    if (await db.collection("users").findOne({email})) return res.status(409).send(page("Register",notice("An account with that email already exists.","error"),null));
    const user={name,email,phone,passwordHash:await bcrypt.hash(password,12),role:"customer",createdAt:new Date()};
    const result=await db.collection("users").insertOne(user);
    req.session.regenerate(err=>{ if(err) return res.status(500).send("Could not start session."); req.session.user={id:String(result.insertedId),name,email,role:"customer"}; saveSession(req,res,"/dashboard"); });
  } catch(e) { console.error(e); res.status(500).send("Could not create account."); }
});
app.get("/login", (req,res) => res.send(page("Log in", `<section class="form-card"><h1>Welcome back</h1><form method="post" action="/login"><label>Email<input type="email" name="email" required autocomplete="username"></label><label>Password<input type="password" name="password" required autocomplete="current-password"></label><button class="button">Continue</button></form><p>New to Smart Ride? <a href="/register">Create an account</a></p></section>`, currentUser(req))));
function saveSession(req,res,nextUrl) { req.session.save(err=>{ if(err){console.error("Session save failed:",err);return res.status(500).send("Could not save your login session. Please try again.");} res.redirect(nextUrl); }); }
app.post("/login", async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database is not configured.");
    const email=(req.body.email||"").trim().toLowerCase(), user=await db.collection("users").findOne({email});
    if(!user || !await bcrypt.compare(req.body.password||"",user.passwordHash)) return res.status(401).send(page("Log in",notice("Email or password is incorrect.","error"),null));
    const configuredAdmin=(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
    if(configuredAdmin && email===configuredAdmin && user.role!=="admin") { await db.collection("users").updateOne({_id:user._id},{$set:{role:"admin"}}); user.role="admin"; }
    if(user.role==="admin") {
      req.session.regenerate(err=>{
        if(err) return res.status(500).send("Could not start session.");
        req.session.pendingAdmin={id:String(user._id),name:user.name,email:user.email,role:"admin"};
        saveSession(req,res,user.twoFactorSecret?"/admin/2fa/login":"/admin/2fa/setup");
      });
      return;
    }
    req.session.regenerate(err=>{ if(err) return res.status(500).send("Could not start session."); req.session.user={id:String(user._id),name:user.name,email:user.email,role:user.role}; saveSession(req,res,user.role==="driver"?"/driver/dashboard":"/dashboard"); });
  } catch(e) { console.error(e); res.status(500).send("Login failed. Please try again."); }
});
app.get("/admin/2fa/setup", async (req,res)=>{
  if(!req.session.pendingAdmin) return res.redirect("/login");
  try {
    if(!req.session.totpSetupSecret) req.session.totpSetupSecret=speakeasy.generateSecret({name:`SMART RIDE (${req.session.pendingAdmin.email})`,length:20}).base32;
    const otpauth=speakeasy.otpauthURL({secret:req.session.totpSetupSecret,label:`SMART RIDE:${req.session.pendingAdmin.email}`,issuer:"SMART RIDE",encoding:"base32"});
    const qr=await QRCode.toDataURL(otpauth);
    res.send(page("Secure admin login",`<section class="form-card"><h1>Set up administrator 2FA</h1><p>Scan this QR code using Google Authenticator, Microsoft Authenticator, or another authenticator app. Then enter the six-digit code to finish setup.</p><img alt="Authenticator setup QR code" style="display:block;max-width:260px;width:100%;margin:1rem auto" src="${qr}"><form method="post" action="/admin/2fa/setup"><label>Six-digit authenticator code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button class="button">Enable 2FA and open admin portal</button></form><p class="small-note">Keep your authenticator app on your phone. Do not share its codes.</p></section>`,null));
  } catch(e){console.error(e);res.status(500).send("Could not create the 2FA setup. Please retry.");}
});
app.post("/admin/2fa/setup", async(req,res)=>{
  try {
    const pending=req.session.pendingAdmin, secret=req.session.totpSetupSecret, code=String(req.body.code||"").replace(/\s/g,"");
    if(!pending||!secret) return res.redirect("/login");
    if(!speakeasy.totp.verify({secret,encoding:"base32",token:code,window:1})) return res.status(400).send(page("Set up 2FA",notice("That code is not correct. Check your authenticator app and try again.","error")+`<p><a href="/admin/2fa/setup">Return to setup</a></p>`,null));
    await db.collection("users").updateOne({_id:new ObjectId(pending.id),role:"admin"},{$set:{twoFactorSecret:secret,twoFactorEnabled:true,twoFactorEnabledAt:new Date()}});
    req.session.user=pending; delete req.session.pendingAdmin; delete req.session.totpSetupSecret; saveSession(req,res,"/admin");
  } catch(e){console.error(e);res.status(500).send("Could not save 2FA. Please retry.");}
});
app.get("/admin/2fa/login",(req,res)=>{
  if(!req.session.pendingAdmin) return res.redirect("/login");
  res.send(page("Administrator verification",`<section class="form-card"><h1>Verify administrator login</h1><p>Enter the six-digit code from your authenticator app.</p><form method="post" action="/admin/2fa/login"><label>Authenticator code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="button">Verify and open admin portal</button></form><form method="post" action="/logout"><button class="navbtn">Cancel</button></form></section>`,null));
});
app.post("/admin/2fa/login",async(req,res)=>{
  try {
    const pending=req.session.pendingAdmin, code=String(req.body.code||"").replace(/\s/g,"");
    if(!pending) return res.redirect("/login");
    const user=await db.collection("users").findOne({_id:new ObjectId(pending.id),role:"admin",twoFactorEnabled:true});
    if(!user||!speakeasy.totp.verify({secret:user.twoFactorSecret,encoding:"base32",token:code,window:1})) return res.status(401).send(page("Administrator verification",notice("The authenticator code is incorrect. Please try again.","error")+`<p><a href="/admin/2fa/login">Try again</a></p>`,null));
    req.session.user=pending; delete req.session.pendingAdmin; saveSession(req,res,"/admin");
  }catch(e){console.error(e);res.status(500).send("Could not verify 2FA. Please retry.");}
});
app.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/")));

app.get("/book", (req,res) => res.send(page("Book a ride", `<section class="form-card wide-card"><h1>Book a ride in Calabar</h1><p>Either type an address and leave the field to find it on the map, or tap the map to choose pickup first and destination second. You can edit both addresses.</p><div id="booking-map" class="map-panel"></div><div class="map-legend"><span>● Pickup</span><span>● Destination</span></div><form method="post" action="/book" id="booking-form"><label>Pickup address<input id="pickup" name="pickup" required maxlength="250" placeholder="Type pickup address or tap the map"></label><label>Destination address<input id="destination" name="destination" required maxlength="250" placeholder="Type destination address or tap the map"></label><input type="hidden" name="pickupLat" id="pickupLat"><input type="hidden" name="pickupLng" id="pickupLng"><input type="hidden" name="destinationLat" id="destinationLat"><input type="hidden" name="destinationLng" id="destinationLng"><label>Passenger phone<input name="phone" required maxlength="40"></label><label>Service type<select name="rideType" id="rideType"><option value="Car - Standard">Car - Standard</option><option value="Car - Comfort">Car - Comfort</option><option value="Car - XL">Car - XL</option><option value="Motorcycle">Motorcycle</option><option value="Tricycle">Tricycle</option><option value="Delivery vehicle">Delivery vehicle</option></select></label><label>Payment method<select name="paymentMethod" id="paymentMethod"><option value="Cash">Cash to driver</option><option value="Paystack">Pay online with Paystack (card, USSD or bank transfer)</option></select></label><div id="fare-preview" class="notice">Choose pickup and destination on the map to calculate your estimate.</div><button class="button" id="book-submit">Request ride</button></form><p class="small-note">Map and route services use OpenStreetMap data and a public routing service; availability and accuracy can vary. The final fare is confirmed in the app.</p></section><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
(function(){const map=L.map('booking-map').setView([4.9757,8.3417],13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);let pickupMarker=null,destMarker=null,line=null;const pts={pickup:null,dest:null};const names={pickup:'Pickup',dest:'Destination'};async function reverse(lat,lng){try{const r=await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat='+lat+'&lon='+lng);const d=await r.json();return d.display_name||lat.toFixed(5)+', '+lng.toFixed(5)}catch(e){return lat.toFixed(5)+', '+lng.toFixed(5)}}async function forward(address){const u='https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ng&q='+encodeURIComponent(address+', Calabar, Cross River, Nigeria');const r=await fetch(u);const d=await r.json();if(!d.length)throw new Error('Address not found');return {lat:Number(d[0].lat),lng:Number(d[0].lon),address:d[0].display_name}}function setInput(which,lat,lng,address){if(which==='pickup'){document.getElementById('pickupLat').value=lat;document.getElementById('pickupLng').value=lng;document.getElementById('pickup').value=address}else{document.getElementById('destinationLat').value=lat;document.getElementById('destinationLng').value=lng;document.getElementById('destination').value=address}}async function route(){if(!pts.pickup||!pts.dest)return;try{const url='https://router.project-osrm.org/route/v1/driving/'+pts.pickup.lng+','+pts.pickup.lat+';'+pts.dest.lng+','+pts.dest.lat+'?overview=full&geometries=geojson';const r=await fetch(url);const d=await r.json();if(d.code!=='Ok')throw new Error();if(line)map.removeLayer(line);line=L.geoJSON(d.routes[0].geometry,{style:{color:'#087e68',weight:5}}).addTo(map);map.fitBounds(line.getBounds(),{padding:[20,20]});const km=d.routes[0].distance/1000;const category=document.getElementById('rideType').value.toLowerCase();let base=800,per=250;if(category.includes('motorcycle')){base=300;per=100}else if(category.includes('tricycle')){base=500;per=150}else if(category.includes('delivery')){base=500;per=180}else if(category.includes('comfort')){base=1200;per=350}else if(category.includes('xl')){base=1500;per=400}const estimate=Math.max(500,Math.round(base+km*per));document.getElementById('fare-preview').textContent='Estimated distance: '+km.toFixed(1)+' km · Approximate duration: '+Math.max(1,Math.round(d.routes[0].duration/60))+' min · Estimated fare: ₦'+estimate.toLocaleString('en-NG')+'. Final fare may vary.'}catch(e){document.getElementById('fare-preview').textContent='Route estimate unavailable. Try selecting the points again.'}}async function choosePoint(which,lat,lng,address){lat=Number(Number(lat).toFixed(6));lng=Number(Number(lng).toFixed(6));const point={lat,lng};if(which==='pickup'){pts.pickup=point;if(pickupMarker)map.removeLayer(pickupMarker);pickupMarker=L.marker([lat,lng]).addTo(map).bindPopup('Pickup').openPopup();setInput('pickup',lat,lng,address); }else{pts.dest=point;if(destMarker)map.removeLayer(destMarker);destMarker=L.marker([lat,lng]).addTo(map).bindPopup('Destination').openPopup();setInput('dest',lat,lng,address);}if(pts.pickup&&pts.dest)await route()}for(const [field,which] of [['pickup','pickup'],['destination','dest']]){const input=document.getElementById(field);input.addEventListener('change',async()=>{const address=input.value.trim();if(!address)return;try{document.getElementById('fare-preview').textContent='Finding address on map…';const p=await forward(address);if(p.lat<4.75||p.lat>5.2||p.lng<8.1||p.lng>8.7)throw new Error('outside service area');await choosePoint(which,p.lat,p.lng,p.address);map.setView([p.lat,p.lng],15)}catch(e){alert('Could not find that address within the Calabar service area. Try a nearby landmark or choose the point directly on the map.');}})}map.on('click',async function(e){const lat=Number(e.latlng.lat.toFixed(6)),lng=Number(e.latlng.lng.toFixed(6));if(!pts.pickup||pts.dest){if(destMarker)map.removeLayer(destMarker);if(line)map.removeLayer(line);pts.pickup={lat,lng};pts.dest=null;if(pickupMarker)map.removeLayer(pickupMarker);pickupMarker=L.marker([lat,lng]).addTo(map).bindPopup('Pickup').openPopup();if(destMarker)map.removeLayer(destMarker);document.getElementById('destination').value='';document.getElementById('destinationLat').value='';document.getElementById('destinationLng').value='';const a=await reverse(lat,lng);setInput('pickup',lat,lng,a)}else{pts.dest={lat,lng};destMarker=L.marker([lat,lng]).addTo(map).bindPopup('Destination').openPopup();const a=await reverse(lat,lng);setInput('dest',lat,lng,a);await route()}});document.getElementById('rideType').addEventListener('change',route);document.getElementById('booking-form').addEventListener('submit',function(e){if(!pts.pickup||!pts.dest){e.preventDefault();alert('Tap the map twice: pickup first, destination second.');return}const b=document.getElementById('book-submit');b.disabled=true;b.textContent='Submitting…'});})();
</script>`, currentUser(req))));
app.post("/book", requireLogin, async (req,res) => {
  try {
    const {pickup,destination,phone,rideType,paymentMethod}=req.body;
    if(!db) return res.status(503).send("Database is not configured. Please try again later.");
    if(!pickup?.trim()||!destination?.trim()||!phone?.trim()) return res.status(400).send("Please complete all required fields.");
    const allowedRideTypes=["Car - Standard","Car - Comfort","Car - XL","Motorcycle","Tricycle","Delivery vehicle"];
    if(!allowedRideTypes.includes(rideType)) return res.status(400).send("Choose a supported service type.");
    const pickupLat=Number(req.body.pickupLat),pickupLng=Number(req.body.pickupLng),destinationLat=Number(req.body.destinationLat),destinationLng=Number(req.body.destinationLng);
    const route=await getRouteInfo(pickupLat,pickupLng,destinationLat,destinationLng);
    const fareEstimateNGN=await estimateFare(rideType||"Car - Standard",route.distanceKm);
    const method=paymentMethod==="Paystack"?"Paystack":"Cash";
    const trip={customerId:new ObjectId(req.session.user.id),customerName:req.session.user.name,customerEmail:req.session.user.email,pickup:pickup.trim(),destination:destination.trim(),phone:phone.trim(),rideType:rideType||"Car - Standard",paymentMethod:method,fareEstimateNGN,finalFareNGN:null,commissionNGN:null,distanceKm:Number(route.distanceKm.toFixed(2)),durationMins:route.durationMins,pickupLocation:{type:"Point",coordinates:[pickupLng,pickupLat]},destinationLocation:{type:"Point",coordinates:[destinationLng,destinationLat]},paymentStatus:method==="Paystack"?"pending":"not_required",status:method==="Paystack"?"payment_pending":"requested",city:"Calabar",createdAt:new Date(),driverId:null};
    const result=await db.collection("rides").insertOne(trip);
    if(method==="Cash") notifyEligibleDriversOfRide(result.insertedId).catch(e=>console.error("Driver ride notification error:",e));
    if(method==="Paystack") {
      try {
        const reference=`SR-RIDE-${result.insertedId}-${Date.now()}`;
        const data=await paystackRequest("/transaction/initialize","POST",{email:req.session.user.email,amount:String(Math.round(fareEstimateNGN*100)),currency:"NGN",reference,callback_url:`${appBaseUrl(req)}/payments/paystack/callback`,channels:["card","ussd","bank_transfer"],metadata:{type:"ride",rideId:String(result.insertedId),customerId:req.session.user.id,custom_fields:[{display_name:"SMART RIDE booking",variable_name:"smart_ride_booking",value:String(result.insertedId)}]}});
        await db.collection("payments").insertOne({reference,type:"ride",rideId:String(result.insertedId),userId:req.session.user.id,email:req.session.user.email,amountNGN:fareEstimateNGN,status:"initialized",createdAt:new Date()});
        await db.collection("rides").updateOne({_id:result.insertedId},{$set:{paymentReference:reference}});
        return res.redirect(data.authorization_url);
      } catch(payError) {
        console.error("Paystack initialization failed:",payError.message);
        await db.collection("rides").updateOne({_id:result.insertedId},{$set:{status:"payment_failed",paymentStatus:"failed",paymentError:payError.message}});
        return res.status(502).send(page("Payment unavailable",`${notice("The ride was saved, but Paystack checkout could not be started. No payment was collected. Please try again or choose cash.","error")}<p><a href="/book">Return to booking</a> · <a href="/dashboard">Dashboard</a></p>`,currentUser(req)));
      }
    }
    res.send(page("Ride requested",`${notice("Your ride request has been recorded. Drivers can see it when their account is approved, subscribed, and online.") }<section class="form-card"><h1>Request received</h1><p>Reference: ${result.insertedId}</p><p>Estimated distance: ${route.distanceKm.toFixed(1)} km</p><p>Estimated fare: ₦${fareEstimateNGN.toLocaleString("en-NG")}</p><p><a href="/dashboard">View dashboard</a></p></section>`,currentUser(req)));
  } catch(e) { console.error(e); res.status(400).send(page("Booking problem",notice(e.message||"Could not save ride request.","error"),currentUser(req))); }
});

app.get("/payments/paystack/callback", async (req,res) => {
  const reference=String(req.query.reference||"");
  if(!reference||!db) return res.status(400).send(page("Payment verification",notice("Missing payment reference or database unavailable.","error"),currentUser(req)));
  try {
    const payment=await db.collection("payments").findOne({reference,...(currentUser(req)?{userId:currentUser(req).id}:{})});
    if(!payment) return res.status(404).send(page("Payment verification",notice("Payment record not found.","error"),currentUser(req)));
    const verified=await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
    if(verified.status!=="success" || Number(verified.amount)!==Math.round(payment.amountNGN*100) || verified.currency!=="NGN") {
      await db.collection("payments").updateOne({reference},{$set:{status:verified.status||"failed",verifiedAt:new Date(),gatewayResponse:verified.gateway_response||null}});
      if(payment.type==="ride") await db.collection("rides").updateOne({_id:new ObjectId(payment.rideId),paymentReference:reference},{$set:{paymentStatus:"failed",status:"payment_failed"}});
      return res.send(page("Payment not confirmed",`${notice("Paystack has not confirmed a successful payment for the expected amount. The ride will not be sent to drivers.","error")}<p><a href="/dashboard">Return to dashboard</a></p>`,currentUser(req)));
    }
    await db.collection("payments").updateOne({reference,status:{$ne:"success"}},{$set:{status:"success",channel:verified.channel,paidAt:verified.paid_at?new Date(verified.paid_at):new Date(),verifiedAt:new Date(),paystackTransactionId:verified.id}});
    if(payment.type==="ride") { const released=await db.collection("rides").updateOne({_id:new ObjectId(payment.rideId),paymentReference:reference,paymentStatus:{$ne:"paid"}},{$set:{paymentStatus:"paid",status:"requested",paidAt:new Date(),paymentChannel:verified.channel,updatedAt:new Date()}}); if(released.modifiedCount) notifyEligibleDriversOfRide(new ObjectId(payment.rideId)).catch(e=>console.error("Driver ride notification error:",e)); }
    if(payment.type==="cash_commission") {
      await db.collection("driverLedger").updateOne({_id:new ObjectId(payment.ledgerId),driverId:payment.driverId,paymentStatus:"unpaid"},{$set:{paymentStatus:"paid_pending_admin",commissionPaidAt:new Date(),commissionPaymentReference:reference,updatedAt:new Date()}});
    }
    if(payment.type==="subscription") {
      const driverId=new ObjectId(payment.driverId);
      const driver=await db.collection("driverApplications").findOne({_id:driverId,status:"approved"});
      if(driver && driver.subscriptionPaymentReference!==reference) {const days=Number(await getSetting("subscriptionDays",30));await db.collection("driverApplications").updateOne({_id:driverId,status:"approved",subscriptionPaymentReference:{$ne:reference}},{$set:{subscriptionStatus:"active",subscriptionExpiresAt:new Date(Date.now()+days*86400000),subscriptionPaidAt:new Date(),subscriptionPaymentReference:reference}});}
    }
    res.send(page("Payment successful",`${notice("Paystack confirmed your payment. Your booking/subscription has been updated.","success")}<p>Reference: ${escapeHtml(reference)}</p><p><a class="button" href="/dashboard">Go to dashboard</a> <a class="button secondary" href="/driver/dashboard">Driver dashboard</a></p>`,currentUser(req)));
  } catch(e) {console.error("Paystack verification failed:",e.message);res.status(502).send(page("Payment verification",notice("We could not verify this payment right now. Do not pay again immediately; check your dashboard or contact support.","error"),currentUser(req)));}
});
app.get("/driver", (req,res) => res.send(page("Driver application", `<section class="form-card"><h1>Drive with Smart Ride</h1><p>Submit your details for administrator review. A profile photo is optional; uploaded photos require Cloudinary credentials in Render.</p><form method="post" action="/driver" enctype="multipart/form-data"><label>Full name<input name="name" required maxlength="100"></label><label>Email<input type="email" name="email" required maxlength="160"></label><label>Phone<input name="phone" required maxlength="40"></label><label>City / service area<input name="area" required maxlength="100" value="Calabar"></label><label>Vehicle category<select name="vehicleType" required><option value="Car">Car</option><option value="Motorcycle">Motorcycle</option><option value="Tricycle">Tricycle</option><option value="Delivery vehicle">Delivery vehicle</option></select></label><label>Vehicle make and model<input name="vehicle" required maxlength="120" placeholder="e.g. Toyota Corolla"></label><label>Vehicle colour<input name="vehicleColor" required maxlength="60" placeholder="e.g. Silver"></label><label>Vehicle registration / plate number<input name="plate" required maxlength="40"></label><label>Driver profile photo (JPEG, PNG or WebP; max 4 MB)<input type="file" name="photo" accept="image/jpeg,image/png,image/webp"></label><label>Create driver password<input type="password" name="password" required minlength="8" autocomplete="new-password"></label><button class="button">Submit application</button></form></section>`,currentUser(req))));
app.post("/driver", upload.single("photo"), async (req,res) => {
  try {
    const {name,email,phone,area,vehicleType,vehicle,vehicleColor,plate,password}=req.body;
    if(!db) return res.status(503).send("Database is not configured. Please try again later.");
    if(!name||!email||!phone||!area||!vehicle||!plate||!password||password.length<8) return res.status(400).send("Complete all fields and use a password of at least 8 characters.");
    const normalizedEmail=email.trim().toLowerCase();
    if(await db.collection("driverApplications").findOne({email:normalizedEmail})) return res.status(409).send(page("Driver application",notice("An application already exists for this email. Use driver login or contact support.","error"),currentUser(req)));
    let profilePhotoUrl="";
    if(req.file) profilePhotoUrl=await uploadDriverPhoto(req.file.buffer);
    const result=await db.collection("driverApplications").insertOne({name:name.trim(),email:normalizedEmail,passwordHash:await bcrypt.hash(password,12),phone:phone.trim(),area:area.trim(),vehicleType:vehicleType||"Car",vehicle:vehicle.trim(),vehicleColor:String(vehicleColor||"").trim(),plate:plate.trim(),profilePhotoUrl,status:"pending_review",subscriptionStatus:"unpaid",subscriptionExpiresAt:null,isOnline:false,declinedRideIds:[],totalTrips:0,totalEarningsNGN:0,ratingAverage:0,ratingCount:0,createdAt:new Date()});
    res.send(page("Application submitted",`${notice("Your driver application has been submitted for review.")}<section class="form-card"><p>Application reference: ${result.insertedId}</p><p>Submitting this form does not mean you are approved to carry passengers. After approval and subscription activation, use <a href="/driver/login">driver login</a>.</p></section>`,currentUser(req)));
  } catch(e) { console.error(e); const message=String(e.message||"").includes("Cloudinary")?e.message:"Could not submit application. Check the database and uploaded photo settings, then try again."; res.status(500).send(page("Application error",notice(message,"error"),currentUser(req))); }
});
app.get("/driver/login", (req,res) => res.send(page("Driver login", `<section class="form-card"><h1>Driver login</h1><p>Only approved drivers with an active subscription can go online and accept rides.</p><form method="post" action="/driver/login"><label>Email<input type="email" name="email" required></label><label>Password<input type="password" name="password" required></label><button class="button">Log in as driver</button></form><p>Not registered? <a href="/driver">Apply to drive</a></p></section>`,currentUser(req))));
app.post("/driver/login", async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database is not configured.");
    const email=(req.body.email||"").trim().toLowerCase();
    const driver=await db.collection("driverApplications").findOne({email});
    if(!driver || !driver.passwordHash || !await bcrypt.compare(req.body.password||"",driver.passwordHash)) return res.status(401).send(page("Driver login",notice("Email or password is incorrect.","error"),null));
    if(driver.status!=="approved") return res.status(403).send(page("Driver login",notice("Your application is not approved yet. Please wait for administrator review.","error"),null));
    req.session.regenerate(err=>{ if(err) return res.status(500).send("Could not start session."); req.session.user={id:String(driver._id),name:driver.name,email:driver.email,role:"driver"}; res.redirect("/driver/dashboard"); });
  } catch(e) { console.error(e); res.status(500).send("Driver login failed."); }
});
function requireDriver(req,res,next) { if(!currentUser(req)) return res.redirect("/driver/login"); if(currentUser(req).role!=="driver") return res.status(403).send(page("Forbidden",notice("Driver access required.","error"),currentUser(req))); next(); }
function rideCompatible(rideType, vehicleType) {
  const r=String(rideType||"").toLowerCase(), v=String(vehicleType||"").toLowerCase();
  if(r.startsWith("car")) return v==="car";
  if(r.includes("motorcycle")) return v==="motorcycle";
  if(r.includes("tricycle")) return v==="tricycle";
  if(r.includes("delivery")) return v==="delivery vehicle";
  return false;
}
const DAY_MS = 24 * 60 * 60 * 1000;
async function enforceSmartLock() {
  if (!db) return;
  const now = new Date();
  const overdue = await db.collection("driverLedger").find({
    entryType: "cash_commission_due", paymentStatus: "unpaid", dueAt: { $lte: now }
  }).toArray();
  const driverIds = [...new Set(overdue.map(x => x.driverId).filter(Boolean))];
  for (const driverId of driverIds) {
    await db.collection("driverApplications").updateOne(
      { _id: new ObjectId(driverId), smartLockStatus: { $ne: "locked" } },
      { $set: { smartLockStatus: "locked", smartLockLockedAt: now, smartLockReason: "Overdue cash-ride commission", isOnline: false } }
    );
  }
}
async function recoverMissingCompletedRideLedgers() {
  if (!db) return;
  const completed = await db.collection("rides").find({status:"completed",driverId:{$ne:null},finalFareNGN:{$type:"number"},commissionNGN:{$type:"number"}}).sort({completedAt:-1}).limit(200).toArray();
  for (const ride of completed) {
    const entryType = String(ride.paymentMethod).toLowerCase()==="cash" ? "cash_commission_due" : "driver_payable";
    const existing = await db.collection("driverLedger").findOne({rideId:String(ride._id),entryType});
    if (existing) continue;
    const driver = await db.collection("driverApplications").findOne({_id:new ObjectId(ride.driverId)});
    if (driver) await recordCompletedRideLedger(ride,driver,ride.finalFareNGN,ride.commissionNGN);
  }
}
async function driverIsSmartLocked(driverId) {
  if (!db) return false;
  await enforceSmartLock();
  const driver = await db.collection("driverApplications").findOne({ _id: new ObjectId(driverId) }, { projection: { smartLockStatus: 1 } });
  return driver?.smartLockStatus === "locked";
}
async function recordCompletedRideLedger(ride, driver, fareNGN, commissionNGN) {
  if (!db) return;
  const now = ride.completedAt ? new Date(ride.completedAt) : new Date();
  const cash = String(ride.paymentMethod).toLowerCase() === "cash";
  const commission = Math.max(0, Math.round(commissionNGN));
  const entry = {
    rideId: String(ride._id), driverId: String(driver._id), driverName: driver.name,
    customerName: ride.customerName || "Customer", paymentMethod: ride.paymentMethod,
    entryType: cash ? "cash_commission_due" : "driver_payable",
    fareNGN: Math.round(fareNGN), commissionNGN: commission,
    driverEarningsNGN: Math.max(0, Math.round(fareNGN) - Math.round(commissionNGN)),
    paymentStatus: cash ? (commission > 0 ? "unpaid" : "paid_confirmed") : "not_applicable", payoutStatus: cash ? "not_applicable" : "unpaid",
    createdAt: now, updatedAt: now,
    ...(cash && commission > 0 ? { dueAt: new Date(now.getTime() + DAY_MS), timerStartedAt: now, smartLockAcknowledgedAt: ride.smartLockAcknowledgedAt || ride.acceptedAt || now } : {})
  };
  await db.collection("driverLedger").updateOne({ rideId: String(ride._id), entryType: entry.entryType }, { $setOnInsert: entry }, { upsert: true });
}
async function activeDriver(driverId) {
  await enforceSmartLock();
  const driver=await db.collection("driverApplications").findOne({_id:new ObjectId(driverId)});
  return driver && driver.status==="approved" && driver.smartLockStatus!=="locked" && driver.subscriptionStatus==="active" && driver.subscriptionExpiresAt && new Date(driver.subscriptionExpiresAt)>new Date() ? driver : null;
}
app.post("/driver/subscription/pay", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    const driver=await db.collection("driverApplications").findOne({_id:new ObjectId(currentUser(req).id),status:"approved"});
    if(!driver) return res.status(403).send("Only approved drivers can pay for a subscription.");
    const fee=Number(await getSetting("subscriptionFeeNGN",5000));
    if(!Number.isFinite(fee)||fee<=0) return res.status(400).send("The administrator has not configured a valid subscription fee.");
    const reference=`SR-SUB-${driver._id}-${Date.now()}`;
    const data=await paystackRequest("/transaction/initialize","POST",{email:driver.email,amount:String(Math.round(fee*100)),currency:"NGN",reference,callback_url:`${appBaseUrl(req)}/payments/paystack/callback`,channels:["card","ussd","bank_transfer"],metadata:{type:"subscription",driverId:String(driver._id),custom_fields:[{display_name:"SMART RIDE driver subscription",variable_name:"smart_ride_subscription",value:String(driver._id)}]}});
    await db.collection("payments").insertOne({reference,type:"subscription",driverId:String(driver._id),userId:currentUser(req).id,email:driver.email,amountNGN:fee,status:"initialized",createdAt:new Date()});
    res.redirect(data.authorization_url);
  } catch(e) {console.error(e);res.status(502).send(page("Subscription payment",notice(e.message||"Could not start Paystack checkout.","error"),currentUser(req)));}
});

app.get("/driver/dashboard", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    await enforceSmartLock();
    const driver=await db.collection("driverApplications").findOne({_id:new ObjectId(currentUser(req).id)});
    if(!driver) return res.status(404).send("Driver account not found.");
    const completedTripsCount=await db.collection("rides").countDocuments({driverId:String(driver._id),status:"completed"});
    const ledger=await db.collection("driverLedger").find({driverId:String(driver._id)}).sort({createdAt:-1}).limit(100).toArray();
    const cashDues=ledger.filter(x=>x.entryType==="cash_commission_due"&&x.paymentStatus==="unpaid");
    const unpaidCommission=cashDues.reduce((sum,x)=>sum+Number(x.commissionNGN||0),0);
    const driverPayable=ledger.filter(x=>x.entryType==="driver_payable"&&x.payoutStatus==="unpaid").reduce((sum,x)=>sum+Number(x.driverEarningsNGN||0),0);
    const subscriptionActive=driver.status==="approved" && driver.subscriptionStatus==="active" && driver.subscriptionExpiresAt && new Date(driver.subscriptionExpiresAt)>new Date();
    const openRides=subscriptionActive && driver.smartLockStatus!=="locked" && driver.isOnline ? await db.collection("rides").find({status:"requested",driverId:null,$or:[{paymentMethod:"Cash"},{paymentStatus:"paid"},{paymentStatus:"not_required"}],declinedRideIds:{$ne:String(driver._id)}}).sort({createdAt:1}).limit(50).toArray() : [];
    const compatible=openRides.filter(r=>rideCompatible(r.rideType,driver.vehicleType));
    const assigned=await db.collection("rides").find({driverId:String(driver._id),status:{$in:["accepted","driver_arrived","in_progress"]}}).sort({updatedAt:-1,createdAt:-1}).limit(20).toArray();
    const rideCard=r=>`<article class="form-card"><h3>${escapeHtml(r.rideType||"Ride")}</h3><p><strong>Pickup:</strong> ${escapeHtml(r.pickup)}</p><p><strong>Destination:</strong> ${escapeHtml(r.destination)}</p><p><strong>Customer phone:</strong> ${escapeHtml(r.phone)}</p><p><strong>Payment:</strong> ${escapeHtml(r.paymentMethod)}</p><p><strong>Status:</strong> ${escapeHtml(r.status)}</p>${r.status==="requested"?`<form method="post" action="/driver/ride/${r._id}/accept">${String(r.paymentMethod).toLowerCase()==="cash"?`<label class="check-row"><input type="checkbox" name="smartLockConsent" value="yes" required> I understand Smart Lock starts a 24-hour commission timer after I complete this cash ride and confirm receiving the cash.</label>`:""}<button class="button">Accept ride</button></form><form method="post" action="/driver/ride/${r._id}/decline"><button class="button secondary">Decline</button></form>`:`<form method="post" action="/driver/ride/${r._id}/status"><label>Update status<select name="status">${(r.status==="accepted"?[["driver_arrived","I have arrived"]]:r.status==="driver_arrived"?[["in_progress","Passenger picked up / start trip"]]:[["completed","Complete trip"]]).map(([v,t])=>`<option value="${v}">${t}</option>`).join("")}</select></label>${r.status==="in_progress"?'<label>Final fare (NGN)<input type="number" name="fare" min="0" max="10000000" step="50" required></label>'+(String(r.paymentMethod).toLowerCase()==="cash"?'<label class="check-row"><input type="checkbox" name="cashReceived" value="yes" required> I confirm that I received the full cash fare from the customer.</label>':''):""}<button class="button">Update trip</button></form>`}</article>`;
    res.send(page("Driver dashboard",`<h1>Driver dashboard</h1><div class="driver-profile-head">${driver.profilePhotoUrl?`<img class="driver-avatar" src="${escapeHtml(driver.profilePhotoUrl)}" alt="${escapeHtml(driver.name)} profile photo">`:`<div class="driver-avatar driver-avatar-placeholder" aria-label="No profile photo">${escapeHtml(String(driver.name||"D").slice(0,1).toUpperCase())}</div>`}<div><h2>${escapeHtml(driver.name)}</h2><p>${escapeHtml(driver.vehicleType)} · ${escapeHtml(driver.vehicle)} · ${escapeHtml(driver.vehicleColor||"Colour not set")} · Plate ${escapeHtml(driver.plate)}</p><p><strong>Successfully completed rides:</strong> ${completedTripsCount}</p></div></div><section class="rating-summary"><h2>Your customer rating</h2><p class="rating-stars" aria-label="Average rating ${Number(driver.ratingAverage||0).toFixed(1)} out of 5">${Number(driver.ratingCount||0)>0?'★'.repeat(Math.max(0,Math.min(5,Math.round(Number(driver.ratingAverage||0)))) )+'☆'.repeat(5-Math.max(0,Math.min(5,Math.round(Number(driver.ratingAverage||0))))):'☆☆☆☆☆'}</p><p><strong>${Number(driver.ratingCount||0)>0?Number(driver.ratingAverage).toFixed(1)+' / 5':'Not rated yet'}</strong> · ${Number(driver.ratingCount||0)} customer rating(s)</p></section>${driver.smartLockStatus==="locked"?notice("SMART LOCK: Your driving access is locked because a cash-ride commission became overdue. You can still settle the commission below. After payment is verified, an administrator must approve unlocking your account.","error"):notice(subscriptionActive?"Your subscription is active.":"Your account cannot accept rides until your application is approved and your subscription is active.",subscriptionActive?"success":"error")}${driver.smartLockStatus==="locked"?`<section class="form-card"><h2>Smart Lock account restriction</h2><p>Reason: ${escapeHtml(driver.smartLockReason||"Outstanding cash commission")}</p><p>Outstanding commission: <strong>₦${unpaidCommission.toLocaleString("en-NG")}</strong></p><p>Your account cannot go online or accept new rides while locked. Pay the outstanding commission and wait for administrator approval.</p></section>`:""}${!subscriptionActive?`<section class="form-card"><h2>Driver subscription</h2><p>Current status: ${escapeHtml(driver.subscriptionStatus||"unpaid")}. Default fee: ₦${Number(await getSetting("subscriptionFeeNGN",5000)).toLocaleString("en-NG")} for ${Number(await getSetting("subscriptionDays",30))} days.</p><form method="post" action="/driver/subscription/pay"><button class="button">Pay subscription with Paystack</button></form><p>Checkout supports card, USSD, and bank transfer. Subscription activates only after server-side Paystack verification.</p></section>`:""}<section class="form-card"><h2>Availability</h2><p>Current status: <strong>${driver.isOnline&&subscriptionActive?"Online":"Offline"}</strong></p><form method="post" action="/driver/availability"><input type="hidden" name="online" value="${driver.isOnline?"0":"1"}"><button class="button" ${driver.smartLockStatus==="locked"?"disabled":""}>Go ${driver.isOnline?"offline":"online"}</button></form><p>For safety, going online requires an approved account and an unexpired subscription.</p><button type="button" class="button secondary" id="share-location">Share live location</button><span id="location-status" class="small-note">Location sharing is off.</span></section><script>document.getElementById("share-location")?.addEventListener("click",()=>{if(!navigator.geolocation){document.getElementById("location-status").textContent="GPS is not supported by this browser.";return}navigator.geolocation.watchPosition(async p=>{try{const r=await fetch("/api/driver/location",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat:p.coords.latitude,lng:p.coords.longitude})});document.getElementById("location-status").textContent=r.ok?"Live location updated.":"Could not save location. Check that you are approved, subscribed, and online."}catch(e){document.getElementById("location-status").textContent="Location update failed."}},e=>document.getElementById("location-status").textContent="Location permission denied or unavailable.",{enableHighAccuracy:true,maximumAge:5000,timeout:15000})});</script><h2>Current trips</h2><div class="cards">${assigned.map(rideCard).join("")||'<p>No active trips.</p>'}</div><h2>Smart Lock &amp; financial records</h2><section class="form-card"><p><strong>Driver earnings awaiting manual payout:</strong> ₦${driverPayable.toLocaleString("en-NG")}</p><p><strong>Cash commission owed to SMART RIDE:</strong> ₦${unpaidCommission.toLocaleString("en-NG")}</p><p>Cash-ride commission timers start when you complete the ride and confirm that the cash fare was received. You must settle the commission within 24 hours.</p>${cashDues.map(x=>`<article class="ledger-row"><p>Ride ${escapeHtml(x.rideId)} · commission ₦${Number(x.commissionNGN).toLocaleString("en-NG")}</p><p>Due: ${new Date(x.dueAt).toLocaleString("en-NG")}</p><p class="smartlock-countdown" data-due="${new Date(x.dueAt).toISOString()}">Calculating countdown…</p><form method="post" action="/driver/smart-lock/pay/${escapeHtml(x.rideId)}"><button class="button">Pay commission with Paystack</button></form></article>`).join("")||"<p>No unpaid cash-ride commissions.</p>"}<p class="small-note">If you have already paid by bank transfer outside Paystack, contact the administrator. The administrator must verify payment and separately approve any Smart Lock unlock.</p></section><script>function updateSmartLockTimers(){document.querySelectorAll(".smartlock-countdown").forEach(el=>{const ms=new Date(el.dataset.due).getTime()-Date.now();if(ms<=0){el.textContent="OVERDUE — Smart Lock restriction may be applied.";el.classList.add("error");return}const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000);el.textContent="Time to settle: "+h+"h "+m+"m "+s+"s"})}updateSmartLockTimers();setInterval(updateSmartLockTimers,1000);</script><h2>Available ride requests</h2><p>Enable push notifications above to receive alerts for compatible ride requests while the website is in the background or closed. Open this dashboard to accept a request.</p><div class="cards">${compatible.map(rideCard).join("")||'<p>No matching ride requests are available right now.</p>'}</div><p><strong>Successfully completed rides:</strong> ${completedTripsCount} · <strong>Recorded earnings:</strong> ₦${Number(driver.totalEarningsNGN||0).toLocaleString("en-NG")}</p>`,currentUser(req)));
  } catch(e) { console.error(e); res.status(500).send("Driver dashboard unavailable."); }
});
app.post("/driver/availability", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    const driver=await activeDriver(currentUser(req).id);
    const wantsOnline=req.body.online==="1";
    if(await driverIsSmartLocked(currentUser(req).id)) return res.status(403).send(page("Smart Lock restriction",notice("Your account is locked by Smart Lock because a cash-ride commission is overdue. Settle the amount and wait for administrator approval.","error"),currentUser(req)));
    if(wantsOnline&&!driver) return res.status(403).send(page("Subscription required",notice("Your driver account must be approved and have an active, unexpired subscription before going online.","error"),currentUser(req)));
    await db.collection("driverApplications").updateOne({_id:new ObjectId(currentUser(req).id)},{$set:{isOnline:wantsOnline,availabilityUpdatedAt:new Date()}});
    res.redirect("/driver/dashboard");
  } catch(e) { console.error(e); res.status(400).send("Could not update availability."); }
});
app.post("/driver/ride/:id/accept", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    const driver=await activeDriver(currentUser(req).id);
    if(!driver||!driver.isOnline) return res.status(403).send("Your account must have an active subscription and be online to accept rides.");
    const id=new ObjectId(req.params.id);
    const ride=await db.collection("rides").findOne({_id:id,status:"requested",driverId:null});
    if(!ride||!rideCompatible(ride.rideType,driver.vehicleType)) return res.status(409).send("This ride is no longer available or does not match your vehicle category.");
    if(String(ride.paymentMethod).toLowerCase()==="cash" && req.body.smartLockConsent!=="yes") return res.status(400).send("You must acknowledge the 24-hour Smart Lock commission policy before accepting a cash ride.");
    const acceptedAt=new Date();
    const completedTripsCount=await db.collection("rides").countDocuments({driverId:String(driver._id),status:"completed"});
    const profileSnapshot={driverPhoto:driver.profilePhotoUrl||"",driverRatingAverage:Number(driver.ratingAverage||0),driverRatingCount:Number(driver.ratingCount||0),driverCompletedTrips:completedTripsCount,driverVehicleColor:driver.vehicleColor||"Not provided",driverVehicleMake:driver.vehicle||"Not provided"};
    const result=await db.collection("rides").updateOne({_id:id,status:"requested",driverId:null,declinedRideIds:{$ne:String(driver._id)}},{$set:{status:"accepted",driverId:String(driver._id),driverName:driver.name,driverPhone:driver.phone,driverVehicle:driver.vehicle,driverPlate:driver.plate,acceptedAt,updatedAt,...profileSnapshot,...(String(ride.paymentMethod).toLowerCase()==="cash"?{smartLockAcknowledgedAt:acceptedAt,smartLockConsent:true}:{})}});
    if(!result.modifiedCount) return res.status(409).send("Another driver has already accepted this ride.");
    const pushMessage=`${driver.name} accepted your ride. Vehicle: ${driver.vehicle||driver.vehicleType}, plate ${driver.plate}.`;
    await db.collection("notifications").insertOne({userId:String(ride.customerId),rideId:String(id),type:"driver_assigned",title:"Your SMART RIDE driver has accepted",message:pushMessage,driverId:String(driver._id),read:false,createdAt:acceptedAt});
    sendPushToUser(String(ride.customerId),{title:"Your driver accepted",body:pushMessage,url:"/dashboard",tag:`driver-assigned-${String(id)}`,data:{rideId:String(id),type:"driver_assigned"}}).catch(e=>console.error("Customer push error:",e));
    await db.collection("driverApplications").updateOne({_id:driver._id},{$set:{isOnline:false}});
    res.redirect("/driver/dashboard");
  } catch(e) { console.error(e); res.status(400).send("Could not accept ride."); }
});
app.post("/driver/ride/:id/decline", requireDriver, async (req,res) => {
  try { if(!db) return res.status(503).send("Database unavailable."); const driver=await activeDriver(currentUser(req).id); if(!driver) return res.status(403).send("Active subscription required."); await db.collection("rides").updateOne({_id:new ObjectId(req.params.id),status:"requested",driverId:null},{$addToSet:{declinedRideIds:String(driver._id)}}); res.redirect("/driver/dashboard"); }
  catch(e) { res.status(400).send("Could not decline ride."); }
});
app.post("/driver/ride/:id/status", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    const driver=await db.collection("driverApplications").findOne({_id:new ObjectId(currentUser(req).id)}); if(!driver||driver.status!=="approved") return res.status(403).send("Approved driver account required.");
    const id=new ObjectId(req.params.id), next=req.body.status;
    const ride=await db.collection("rides").findOne({_id:id,driverId:String(driver._id),status:{$in:["accepted","driver_arrived","in_progress"]}});
    if(!ride) return res.status(404).send("Active trip not found.");
    const transitions={accepted:"driver_arrived",driver_arrived:"in_progress",in_progress:"completed"};
    if(transitions[ride.status]!==next) return res.status(400).send("Invalid trip status transition.");
    const update={status:next,updatedAt:new Date()};
    if(next==="completed") {
      if(String(ride.paymentMethod).toLowerCase()==="cash" && req.body.cashReceived!=="yes") return res.status(400).send("Confirm that you received the cash fare before completing this cash ride.");
      const fare=Number(req.body.fare); if(!Number.isFinite(fare)||fare<0||fare>10000000) return res.status(400).send("Enter a valid final fare.");
      const commissionPercent=Number(await getSetting("commissionPercent",15));
      update.finalFareNGN=Math.round(fare); update.commissionNGN=Math.round(fare*commissionPercent/100); update.completedAt=new Date();
    }
    const result=await db.collection("rides").updateOne({_id:id,driverId:String(driver._id),status:ride.status},{$set:update});
    if(!result.modifiedCount) return res.status(409).send("Trip changed; refresh and try again.");
    if(next==="completed") {
      await db.collection("driverApplications").updateOne({_id:driver._id},{$inc:{totalTrips:1,totalEarningsNGN:update.finalFareNGN-update.commissionNGN},$set:{isOnline:false}});
      await recordCompletedRideLedger({...ride,_id:id,completedAt:update.completedAt},driver,update.finalFareNGN,update.commissionNGN);
    }
    res.redirect("/driver/dashboard");
  } catch(e) { console.error(e); res.status(400).send("Could not update trip status."); }
});

app.post("/driver/smart-lock/pay/:rideId", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    const driverId=currentUser(req).id;
    const ledger=await db.collection("driverLedger").findOne({rideId:String(req.params.rideId),driverId,entryType:"cash_commission_due",paymentStatus:"unpaid"});
    if(!ledger) return res.status(404).send(page("Smart Lock payment",notice("No unpaid commission was found for that ride.","error"),currentUser(req)));
    const driver=await db.collection("driverApplications").findOne({_id:new ObjectId(driverId)});
    const amount=Number(ledger.commissionNGN||0);
    if(amount<=0) return res.status(400).send("Commission amount is invalid.");
    const reference=`SR-COM-${driverId}-${ledger.rideId}-${Date.now()}`;
    const data=await paystackRequest("/transaction/initialize","POST",{email:driver.email,amount:String(Math.round(amount*100)),currency:"NGN",reference,callback_url:`${appBaseUrl(req)}/payments/paystack/callback`,channels:["card","ussd","bank_transfer"],metadata:{type:"cash_commission",driverId,rideId:ledger.rideId,ledgerId:String(ledger._id)}});
    await db.collection("payments").insertOne({reference,type:"cash_commission",driverId,userId:driverId,rideId:ledger.rideId,ledgerId:String(ledger._id),email:driver.email,amountNGN:amount,status:"initialized",createdAt:new Date()});
    res.redirect(data.authorization_url);
  } catch(e) { console.error(e); res.status(502).send(page("Smart Lock payment",notice(e.message||"Could not start Paystack checkout.","error"),currentUser(req))); }
});

app.post("/api/driver/location", requireDriver, async (req,res) => {
  try {
    if(!db) return res.status(503).json({error:"Database unavailable"});
    const lat=Number(req.body.lat),lng=Number(req.body.lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat< -90||lat>90||lng< -180||lng>180) return res.status(400).json({error:"Invalid coordinates"});
    const driver=await activeDriver(currentUser(req).id);
    const hasActiveTrip=driver?!!(await db.collection("rides").findOne({driverId:String(driver._id),status:{$in:["accepted","driver_arrived","in_progress"]}})):false;
    if(!driver||(!driver.isOnline&&!hasActiveTrip)) return res.status(403).json({error:"Active subscription and online status or active trip required"});
    await db.collection("driverApplications").updateOne({_id:driver._id},{$set:{lastLocation:{lat,lng,updatedAt:new Date()},locationUpdatedAt:new Date()}});
    await db.collection("rides").updateMany({driverId:String(driver._id),status:{$in:["accepted","driver_arrived","in_progress"]}},{$set:{driverLocation:{lat,lng,updatedAt:new Date()}}});
    res.json({ok:true});
  } catch(e) {res.status(500).json({error:"Could not update location"});}
});
app.get("/api/customer/ride-updates", requireLogin, async (req,res) => {
  try {
    if(currentUser(req).role!=="customer") return res.status(403).json({error:"Customer access required"});
    if(!db) return res.status(503).json({error:"Database unavailable"});
    const userId=currentUser(req).id;
    const rides=await db.collection("rides").find({customerId:new ObjectId(userId)}).sort({createdAt:-1}).limit(20).toArray();
    const notifications=await db.collection("notifications").find({userId,type:"driver_assigned",read:false}).sort({createdAt:-1}).limit(10).toArray();
    if(notifications.length) await db.collection("notifications").updateMany({_id:{$in:notifications.map(n=>n._id)}},{$set:{read:true,readAt:new Date()}});
    res.json({rides:rides.map(r=>({id:String(r._id),status:r.status,driverName:r.driverName||null,driverPhone:r.driverPhone||null,driverVehicle:r.driverVehicle||null,driverPlate:r.driverPlate||null,driverPhoto:r.driverPhoto||"",driverVehicleColor:r.driverVehicleColor||"Not provided",driverVehicleMake:r.driverVehicleMake||r.driverVehicle||"Not provided",driverRatingAverage:Number(r.driverRatingAverage||0),driverRatingCount:Number(r.driverRatingCount||0),driverCompletedTrips:Number(r.driverCompletedTrips||0),acceptedAt:r.acceptedAt||null})),notifications:notifications.map(n=>({title:n.title,message:n.message,rideId:n.rideId,createdAt:n.createdAt}))});
  } catch(e) { console.error("Customer ride update error:",e); res.status(500).json({error:"Could not load ride updates"}); }
});

app.get("/api/ride/:id/location", requireLogin, async (req,res) => {
  try {
    if(!db) return res.status(503).json({error:"Database unavailable"});
    const ride=await db.collection("rides").findOne({_id:new ObjectId(req.params.id),customerId:new ObjectId(currentUser(req).id)});
    if(!ride) return res.status(404).json({error:"Ride not found"});
    const driver=ride.driverId?await db.collection("driverApplications").findOne({_id:new ObjectId(ride.driverId)}):null;
    res.json({status:ride.status,location:driver?.lastLocation||ride.driverLocation||null,updatedAt:driver?.lastLocation?.updatedAt||ride.driverLocation?.updatedAt||null});
  } catch(e) {res.status(400).json({error:"Invalid ride reference"});}
});

app.post("/rides/:id/rating", requireLogin, async (req,res) => {
  try {
    const user=currentUser(req);
    if(user.role!=="customer") return res.status(403).send(page("Rating",notice("Only customers can rate drivers after a completed ride.","error"),user));
    if(!db) return res.status(503).send("Database unavailable.");
    if(!ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid ride reference.");
    const rating=Number(req.body.rating);
    const comment=String(req.body.comment||"").trim().slice(0,500);
    if(!Number.isInteger(rating)||rating<1||rating>5) return res.status(400).send(page("Rating",notice("Choose a rating from 1 to 5 stars.","error"),user));
    const rideId=new ObjectId(req.params.id);
    const ride=await db.collection("rides").findOne({_id:rideId,customerId:new ObjectId(user.id),status:"completed",driverId:{$type:"string",$ne:""}});
    if(!ride) return res.status(404).send(page("Rating",notice("Only your own completed rides with an assigned driver can be rated.","error"),user));
    if(ride.driverRating) return res.status(409).send(page("Rating",notice("You have already rated this driver for this ride.","error"),user));
    const now=new Date();
    const saved=await db.collection("rides").updateOne({_id:rideId,customerId:new ObjectId(user.id),status:"completed",driverId:ride.driverId,$or:[{driverRating:{$exists:false}},{driverRating:null}]},{$set:{driverRating:rating,driverRatingComment:comment,driverRatedAt:now}});
    if(!saved.modifiedCount) return res.status(409).send(page("Rating",notice("This ride has already been rated. Refresh your dashboard.","error"),user));
    const allRatings=await db.collection("rides").find({driverId:ride.driverId,status:"completed",driverRating:{$type:"number"}},{projection:{driverRating:1}}).toArray();
    const count=allRatings.length;
    const average=count?Math.round((allRatings.reduce((sum,r)=>sum+Number(r.driverRating),0)/count)*100)/100:0;
    if(ObjectId.isValid(ride.driverId)) await db.collection("driverApplications").updateOne({_id:new ObjectId(ride.driverId)},{$set:{ratingAverage:average,ratingCount:count,ratingUpdatedAt:now}});
    res.redirect("/dashboard");
  } catch(e) { console.error("Driver rating error:",e); res.status(500).send("Could not save your rating. Please try again."); }
});

app.get("/profile", requireLogin, async (req,res)=>{
  try {
    const u=await db.collection("users").findOne({_id:new ObjectId(currentUser(req).id)});
    if(!u) return res.redirect("/login");
    res.send(page("My profile",`<section class="form-card"><h1>My profile</h1><div class="driver-profile-head">${u.profilePhotoUrl?`<img class="driver-avatar" src="${escapeHtml(u.profilePhotoUrl)}" alt="Your profile picture">`:`<div class="driver-avatar driver-avatar-placeholder">${escapeHtml(String(u.name||"C").slice(0,1).toUpperCase())}</div>`}<div><strong>${escapeHtml(u.name)}</strong><p>${escapeHtml(u.email)}</p></div></div><form method="post" action="/profile" enctype="multipart/form-data"><label>Full name<input name="name" required maxlength="100" value="${escapeHtml(u.name||"")}"></label><label>Phone number<input name="phone" required maxlength="40" value="${escapeHtml(u.phone||"")}"></label><label>Profile picture (JPEG, PNG or WebP; max 4 MB)<input type="file" name="photo" accept="image/jpeg,image/png,image/webp"></label><button class="button">Save profile</button></form><p class="small-note">Profile picture uploads require Cloudinary image-storage settings on Render.</p></section>`,currentUser(req)));
  } catch(e){console.error(e);res.status(500).send("Could not load your profile.");}
});
app.post("/profile", requireLogin, upload.single("photo"), async(req,res)=>{
  try {
    const name=String(req.body.name||"").trim(), phone=String(req.body.phone||"").trim();
    if(!name||!phone) return res.status(400).send("Enter your name and phone number.");
    const changes={name,phone,updatedAt:new Date()};
    if(req.file) changes.profilePhotoUrl=await uploadDriverPhoto(req.file.buffer);
    await db.collection("users").updateOne({_id:new ObjectId(currentUser(req).id)},{$set:changes});
    req.session.user.name=name;
    req.session.save(err=>{if(err)return res.status(500).send("Profile saved, but session refresh failed. Please log in again.");res.redirect("/profile");});
  } catch(e){console.error("Customer profile update error:",e);res.status(400).send("Could not save profile. Check that Cloudinary is configured and your image is under 4 MB.");}
});

app.get("/dashboard", requireLogin, async (req,res) => {
  try {
    const user=currentUser(req);
    if(user.role==="admin") return res.redirect("/admin");
    if(user.role==="driver") return res.redirect("/driver/dashboard");
    if(!db) return res.status(503).send("Database unavailable.");
    const rides=await db.collection("rides").find({customerId:new ObjectId(user.id)}).sort({createdAt:-1}).limit(20).toArray();
    const rows=rides.map(r=>`<tr data-ride-id="${escapeHtml(String(r._id))}"><td>${escapeHtml(String(r._id))}</td><td>${escapeHtml(r.pickup)} → ${escapeHtml(r.destination)}</td><td class="ride-status-cell">${escapeHtml(r.status)}</td><td class="ride-driver-cell">${r.driverName?`<div class="customer-driver-profile">${r.driverPhoto?`<img class="driver-avatar" src="${escapeHtml(r.driverPhoto)}" alt="${escapeHtml(r.driverName)} profile photo">`:`<div class="driver-avatar driver-avatar-placeholder">${escapeHtml(String(r.driverName).slice(0,1).toUpperCase())}</div>`}<div><strong>${escapeHtml(r.driverName)}</strong><p>Phone: <a href="tel:${escapeHtml(r.driverPhone||"")}">${escapeHtml(r.driverPhone||"Not provided")}</a></p><p>Vehicle: ${escapeHtml(r.driverVehicleMake||r.driverVehicle||"Not provided")} · ${escapeHtml(r.driverVehicleColor||"Not provided")}</p><p>Plate: <strong>${escapeHtml(r.driverPlate||"Not provided")}</strong></p><p class="rating-stars">${Number(r.driverRatingCount||0)>0?"★".repeat(Math.max(0,Math.min(5,Math.round(Number(r.driverRatingAverage||0)))))+"☆".repeat(5-Math.max(0,Math.min(5,Math.round(Number(r.driverRatingAverage||0))))):"☆☆☆☆☆"}</p><p><strong>${Number(r.driverRatingCount||0)>0?Number(r.driverRatingAverage).toFixed(1)+"/5":"Not rated yet"}</strong> · ${Number(r.driverRatingCount||0)} rating(s)</p><p>Successfully completed rides: <strong>${Number(r.driverCompletedTrips||0)}</strong></p></div></div>${["accepted","driver_arrived","in_progress"].includes(r.status)?`<br><a href="#ride-map-${r._id}">View live location</a><div id="ride-map-${r._id}" class="mini-map"></div><script>(function(){const el=document.getElementById("ride-map-${r._id}");if(!el)return;const m=L.map(el).setView([4.9757,8.3417],13);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap"}).addTo(m);let mark;async function upd(){try{const d=await fetch("/api/ride/${r._id}/location").then(x=>x.json());if(d.location){const p=[d.location.lat,d.location.lng];if(!mark)mark=L.marker(p).addTo(m).bindPopup("Driver location");else mark.setLatLng(p);m.setView(p,15)}}catch(e){}}upd();setInterval(upd,5000)})();</script>`:""}`:"Not assigned yet"}</td><td>${escapeHtml(r.paymentMethod)}<br>${escapeHtml(r.paymentStatus||"not_required")}</td><td>${r.finalFareNGN==null?(r.fareEstimateNGN==null?"Not set":"Estimate: ₦"+escapeHtml(String(r.fareEstimateNGN))):"₦"+escapeHtml(String(r.finalFareNGN))}${r.distanceKm?"<br>"+escapeHtml(String(r.distanceKm))+" km":""}${r.status==="completed"&&r.driverId?(r.driverRating?`<br><span class="rating-stars">${'★'.repeat(Number(r.driverRating))}${'☆'.repeat(5-Number(r.driverRating))}</span><br><small>You rated this driver ${Number(r.driverRating)}/5</small>`:`<form method="post" action="/rides/${r._id}/rating" class="rating-form"><label>Rate your driver<select name="rating" required><option value="">Choose 1–5 stars</option><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Average</option><option value="2">2 — Poor</option><option value="1">1 — Very poor</option></select></label><label>Comment (optional)<textarea name="comment" maxlength="500" rows="2" placeholder="Share feedback"></textarea></label><button class="button">Submit rating</button></form>`):""}</td></tr>`).join("");
    res.send(page("Dashboard",`${rides.some(r=>["accepted","driver_arrived","in_progress"].includes(r.status))?`<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>`:""}<section><h1>Hello, ${escapeHtml(user.name)}</h1><p>Manage your ride requests here.</p><div class="driver-profile-head">${user.profilePhotoUrl?`<img class="driver-avatar" src="${escapeHtml(user.profilePhotoUrl)}" alt="Your profile picture">`:`<div class="driver-avatar driver-avatar-placeholder">${escapeHtml(String(user.name||"C").slice(0,1).toUpperCase())}</div>`}<div><a class="button secondary" href="/profile">Edit profile / add picture</a></div></div><a class="button" href="/book">Request another ride</a><section class="form-card"><h2>Ride notifications</h2><p id="ride-notification-status">We will check for driver acceptance updates while this dashboard is open.</p><p class="small-note">For alerts when the website is closed, use the “Enable push notifications” button above.</p></section><script>(function(){const status=document.getElementById("ride-notification-status");let seen=new Set();async function check(){try{const d=await fetch("/api/customer/ride-updates",{cache:"no-store"}).then(r=>r.ok?r.json():null);if(!d)return;for(const n of d.notifications||[]){const key=n.rideId+":"+n.createdAt;if(seen.has(key))continue;seen.add(key);status.textContent=n.message;}for(const ride of d.rides||[]){const row=document.querySelector("[data-ride-id=\'"+ride.id+"\']");if(!row)continue;const statusCell=row.querySelector(".ride-status-cell");if(statusCell)statusCell.textContent=ride.status;if(!ride.driverName)continue;const cell=row.querySelector(".ride-driver-cell");if(!cell)continue;cell.replaceChildren();const card=document.createElement("div");card.className="customer-driver-profile";if(ride.driverPhoto){const img=document.createElement("img");img.className="driver-avatar";img.src=ride.driverPhoto;img.alt=ride.driverName+" profile photo";card.appendChild(img)}else{const avatar=document.createElement("div");avatar.className="driver-avatar driver-avatar-placeholder";avatar.textContent=ride.driverName.slice(0,1).toUpperCase();card.appendChild(avatar)}const details=document.createElement("div");const name=document.createElement("strong");name.textContent=ride.driverName;details.appendChild(name);const addLine=(label,value)=>{const p=document.createElement("p");p.textContent=label+value;details.appendChild(p)};const phone=document.createElement("p"),link=document.createElement("a");link.href="tel:"+(ride.driverPhone||"");link.textContent=ride.driverPhone||"Not provided";phone.textContent="Phone: ";phone.appendChild(link);details.appendChild(phone);addLine("Vehicle: ",(ride.driverVehicleMake||ride.driverVehicle||"Not provided")+" · "+(ride.driverVehicleColor||"Not provided"));addLine("Plate: ",ride.driverPlate||"Not provided");addLine("Rating: ",Number(ride.driverRatingCount)>0?Number(ride.driverRatingAverage).toFixed(1)+"/5 ("+ride.driverRatingCount+" ratings)":"Not rated yet");addLine("Successfully completed rides: ",String(ride.driverCompletedTrips||0));card.appendChild(details);cell.appendChild(card);if(["accepted","driver_arrived","in_progress"].includes(ride.status)){const p=document.createElement("p");p.textContent="Driver assigned. Refresh the page to open the live location map.";cell.appendChild(p)}}const active=(d.rides||[]).find(r=>r.driverName&&["accepted","driver_arrived","in_progress"].includes(r.status));if(active&&status.textContent.includes("check for driver"))status.textContent="Your driver has accepted. Their profile is now displayed in your ride below.";}catch(e){}}check();setInterval(check,5000)})();</script><h2>Your recent rides</h2><div class="table-wrap"><table><thead><tr><th>Reference</th><th>Route</th><th>Status</th><th>Driver</th><th>Payment</th><th>Fare</th></tr></thead><tbody>${rows||'<tr><td colspan="6">No rides yet.</td></tr>'}</tbody></table></div></section>`,user));
  } catch(e) { console.error(e); res.status(500).send("Dashboard unavailable. Check database setup."); }
});
app.get("/admin", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send(page("Forbidden",notice("Administrator access required.","error"),currentUser(req)));
  try {
    if(!db) return res.status(503).send("Database unavailable.");
    const rides=await db.collection("rides").find().sort({createdAt:-1}).limit(100).toArray();
    await enforceSmartLock();
    const apps=await db.collection("driverApplications").find().sort({createdAt:-1}).limit(100).toArray();
    const ledgerRows=await db.collection("driverLedger").find().sort({createdAt:-1}).limit(300).toArray();
    const rideRows=rides.map(r=>`<tr><td>${escapeHtml(String(r._id))}</td><td>${escapeHtml(r.customerName)}</td><td>${escapeHtml(r.pickup)} → ${escapeHtml(r.destination)}</td><td>${escapeHtml(r.rideType||"Car - Standard")}</td><td>${escapeHtml(r.status)}<br>Fare: ${r.finalFareNGN==null?"Not set":"₦"+escapeHtml(String(r.finalFareNGN))}<br>Commission: ${r.commissionNGN==null?"Not calculated":"₦"+escapeHtml(String(r.commissionNGN))}</td><td><form method="post" action="/admin/ride-update"><input type="hidden" name="id" value="${r._id}"><select name="status"><option value="requested">Requested</option><option value="accepted">Accepted</option><option value="driver_arrived">Driver arrived</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select><label>Final fare (NGN)<input type="number" name="finalFareNGN" min="0" step="50" value="${r.finalFareNGN??""}"></label><button>Update ride</button></form></td></tr>`).join("");
    const appRows=apps.map(a=>`<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.phone)}</td><td>${escapeHtml(a.area)}</td><td>${escapeHtml(a.vehicleType||"Car")}</td><td>${a.profilePhotoUrl?`<img class="driver-avatar" style="width:48px;height:48px" src="${escapeHtml(a.profilePhotoUrl)}" alt="Driver photo"> `:""}${escapeHtml(a.vehicle)} · ${escapeHtml(a.vehicleColor||"Colour not provided")} (${escapeHtml(a.plate)})</td><td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.subscriptionStatus||"unpaid")}</td><td>${escapeHtml(a.smartLockStatus||"clear")}</td><td><form method="post" action="/admin/driver-status"><input type="hidden" name="id" value="${a._id}"><select name="status"><option value="pending_review">Pending</option><option value="approved">Approve</option><option value="rejected">Reject</option></select><button>Save</button></form><form method="post" action="/admin/driver-subscription"><input type="hidden" name="id" value="${a._id}"><select name="subscriptionStatus"><option value="unpaid">Unpaid</option><option value="active">Active</option><option value="expired">Expired</option></select><button>Update subscription</button></form></td></tr>`).join("");
    res.send(page("Admin",`<h1>Administrator dashboard</h1><h2>Business settings</h2><p>Commission model: <strong>driver subscription + ride commission</strong>. Current default commission: 15% of the recorded final fare. Driver subscriptions can be paid through Paystack after approval; administrators can also manually update subscription status for support/testing.</p><form method="post" action="/admin/settings"><label>Ride commission percentage<input type="number" name="commissionPercent" min="0" max="50" step="0.5" value="${escapeHtml(String(await getSetting("commissionPercent",15))) }" required></label><label>Driver subscription fee (NGN)<input type="number" name="subscriptionFeeNGN" min="0" step="100" value="${escapeHtml(String(await getSetting("subscriptionFeeNGN",5000))) }" required></label><label>Subscription duration (days)<input type="number" name="subscriptionDays" min="1" max="365" value="${escapeHtml(String(await getSetting("subscriptionDays",30))) }" required></label><button class="button">Save business settings</button></form><h2>Recent ride requests</h2><div class="table-wrap"><table><thead><tr><th>Reference</th><th>Customer</th><th>Route</th><th>Service</th><th>Status / fare</th><th>Update</th></tr></thead><tbody>${rideRows||'<tr><td colspan="6">No rides.</td></tr>'}</tbody></table></div><h2>Driver applications</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Area</th><th>Vehicle type</th><th>Vehicle</th><th>Application</th><th>Subscription</th><th>Smart Lock</th><th>Update</th></tr></thead><tbody>${appRows||'<tr><td colspan="6">No applications.</td></tr>'}</tbody></table></div><h2>Record a manual driver payout</h2><p>First transfer the money to the driver's bank account. Then record the reference here. This form records the payout; it does not transfer money automatically.</p><form method="post" action="/admin/driver-payout" class="form-card"><label>Driver<select name="driverId" required>${apps.map(a=>{const owed=ledgerRows.filter(x=>x.driverId===String(a._id)&&x.entryType==="driver_payable"&&x.payoutStatus==="unpaid").reduce((n,x)=>n+Number(x.driverEarningsNGN||0),0);return `<option value="${a._id}">${escapeHtml(a.name)} — unpaid earnings ₦${owed.toLocaleString("en-NG")}</option>`;}).join("")}</select></label><label>Bank transfer reference<input name="reference" required maxlength="120" placeholder="Bank transaction reference"></label><button class="button">Record payout for selected driver's unpaid earnings</button></form><h2>Smart Lock commission cases and financial ledger</h2><div class="table-wrap"><table><thead><tr><th>Ride</th><th>Driver</th><th>Fare</th><th>Commission</th><th>Timer due</th><th>Status</th><th>Actions</th></tr></thead><tbody>${ledgerRows.map(x=>`<tr><td>${escapeHtml(x.rideId)}</td><td>${escapeHtml(x.driverName||x.driverId)}</td><td>₦${Number(x.fareNGN||0).toLocaleString("en-NG")}</td><td>₦${Number(x.commissionNGN||0).toLocaleString("en-NG")}</td><td>${x.dueAt?new Date(x.dueAt).toLocaleString("en-NG"):"—"}</td><td>${escapeHtml(x.paymentStatus||x.payoutStatus||"—")}</td><td>${x.entryType==="cash_commission_due"&&x.paymentStatus==="unpaid"?`<form method="post" action="/admin/smart-lock/confirm-commission"><input type="hidden" name="ledgerId" value="${x._id}"><label>External payment reference<input name="reference" required maxlength="120" placeholder="Bank transfer reference"></label><button>Confirm received (manual)</button></form>`:""}${x.entryType==="cash_commission_due"&&x.paymentStatus==="paid_pending_admin"?`<form method="post" action="/admin/smart-lock/unlock"><input type="hidden" name="driverId" value="${escapeHtml(x.driverId)}"><button class="button">Approve unlock</button></form>`:""}${x.entryType==="driver_payable"?`<span>Payout: ${escapeHtml(x.payoutStatus||"unpaid")}</span>`:""}</td></tr>`).join("")||'<tr><td colspan="7">No ledger entries yet.</td></tr>'}</tbody></table></div>`,currentUser(req)));
  } catch(e) { console.error(e); res.status(500).send("Admin dashboard unavailable."); }
});
app.post("/admin/smart-lock/confirm-commission", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  try {
    const ledgerId=String(req.body.ledgerId||""), reference=String(req.body.reference||"").trim().slice(0,120);
    if(!ObjectId.isValid(ledgerId)||!reference) return res.status(400).send("Ledger record and payment reference are required.");
    const result=await db.collection("driverLedger").updateOne({_id:new ObjectId(ledgerId),entryType:"cash_commission_due",paymentStatus:"unpaid"},{$set:{paymentStatus:"paid_pending_admin",commissionPaidAt:new Date(),commissionPaymentReference:reference,commissionPaymentMethod:"manual_external",commissionPaymentRecordedBy:currentUser(req).id,updatedAt:new Date()}});
    if(!result.modifiedCount) return res.status(409).send("This commission is no longer unpaid. Refresh the dashboard and check its status.");
    res.redirect("/admin");
  } catch(e) { console.error(e); res.status(400).send("Could not confirm commission payment."); }
});

app.post("/admin/smart-lock/unlock", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  try {
    const driverId=String(req.body.driverId||"");
    if(!ObjectId.isValid(driverId)) return res.status(400).send("Invalid driver.");
    await enforceSmartLock();
    const unpaid=await db.collection("driverLedger").countDocuments({driverId,entryType:"cash_commission_due",paymentStatus:"unpaid",dueAt:{$lte:new Date()}});
    if(unpaid>0) return res.status(400).send(page("Smart Lock unlock",notice("Cannot unlock: the driver still has unpaid cash commissions.","error"),currentUser(req)));
    const paidPending=await db.collection("driverLedger").countDocuments({driverId,entryType:"cash_commission_due",paymentStatus:"paid_pending_admin"});
    if(paidPending===0) return res.status(400).send(page("Smart Lock unlock",notice("No verified commission payment is awaiting approval.","error"),currentUser(req)));
    await db.collection("driverLedger").updateMany({driverId,entryType:"cash_commission_due",paymentStatus:"paid_pending_admin"},{$set:{paymentStatus:"paid_confirmed",commissionApprovedBy:currentUser(req).id,commissionApprovedAt:new Date(),updatedAt:new Date()}});
    await db.collection("driverApplications").updateOne({_id:new ObjectId(driverId)},{$set:{smartLockStatus:"clear",smartLockUnlockedAt:new Date(),smartLockUnlockedBy:currentUser(req).id},$unset:{smartLockReason:"",smartLockLockedAt:""}});
    res.redirect("/admin");
  } catch(e) { console.error(e); res.status(400).send("Could not approve Smart Lock unlock."); }
});
app.post("/admin/driver-payout", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  try {
    const driverId=String(req.body.driverId||""), reference=String(req.body.reference||"").trim().slice(0,120);
    if(!ObjectId.isValid(driverId)||!reference) return res.status(400).send("Driver and bank transfer reference are required.");
    const entries=await db.collection("driverLedger").find({driverId,entryType:"driver_payable",payoutStatus:"unpaid"}).toArray();
    const amount=entries.reduce((sum,x)=>sum+Number(x.driverEarningsNGN||0),0);
    if(amount<=0) return res.status(400).send("No driver earnings are awaiting payout.");
    const payout=await db.collection("driverPayouts").insertOne({driverId,driverName:entries[0].driverName,amountNGN:amount,reference,status:"recorded_paid",recordedBy:currentUser(req).id,createdAt:new Date(),entryIds:entries.map(x=>String(x._id))});
    await db.collection("driverLedger").updateMany({_id:{$in:entries.map(x=>x._id)},payoutStatus:"unpaid"},{$set:{payoutStatus:"paid",payoutId:String(payout.insertedId),payoutReference:reference,payoutAt:new Date(),payoutRecordedBy:currentUser(req).id,updatedAt:new Date()}});
    res.redirect("/admin");
  } catch(e) { console.error(e); res.status(400).send("Could not record driver payout."); }
});

app.post("/admin/driver-status", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  if(!["pending_review","approved","rejected"].includes(req.body.status)) return res.status(400).send("Invalid status");
  try { if(!db) return res.status(503).send("Database unavailable."); await db.collection("driverApplications").updateOne({_id:new ObjectId(req.body.id)},{$set:{status:req.body.status,reviewedAt:new Date(),reviewedBy:currentUser(req).id,...(req.body.status!=="approved"?{isOnline:false}:{})}}); res.redirect("/admin"); }
  catch(e) { res.status(400).send("Could not update application."); }
});
app.post("/admin/settings", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  const commissionPercent=Number(req.body.commissionPercent), subscriptionFeeNGN=Number(req.body.subscriptionFeeNGN), subscriptionDays=Number(req.body.subscriptionDays);
  if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>50||!Number.isFinite(subscriptionFeeNGN)||subscriptionFeeNGN<0||!Number.isInteger(subscriptionDays)||subscriptionDays<1||subscriptionDays>365) return res.status(400).send("Invalid business settings.");
  await db.collection("settings").updateOne({_id:"commissionPercent"},{$set:{value:commissionPercent,updatedAt:new Date()}},{upsert:true});
  await db.collection("settings").updateOne({_id:"subscriptionFeeNGN"},{$set:{value:subscriptionFeeNGN,updatedAt:new Date()}},{upsert:true});
  await db.collection("settings").updateOne({_id:"subscriptionDays"},{$set:{value:subscriptionDays,updatedAt:new Date()}},{upsert:true});
  res.redirect("/admin");
});
app.post("/admin/driver-subscription", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  const status=req.body.subscriptionStatus;
  if(!["unpaid","active","expired"].includes(status)) return res.status(400).send("Invalid subscription status.");
  try {
    const id=new ObjectId(req.body.id); const days=Number(await getSetting("subscriptionDays",30));
    const application=await db.collection("driverApplications").findOne({_id:id});
    if(!application) return res.status(404).send("Driver application not found.");
    if(status==="active" && application.status!=="approved") return res.status(400).send("Approve the driver application before activating a subscription.");
    const update={subscriptionStatus:status,subscriptionUpdatedAt:new Date(),subscriptionUpdatedBy:currentUser(req).id};
    if(status==="active") update.subscriptionExpiresAt=new Date(Date.now()+days*86400000);
    else update.subscriptionExpiresAt=null;
    if(status!=="active") update.isOnline=false;
    await db.collection("driverApplications").updateOne({_id:id},{$set:update});
    res.redirect("/admin");
  } catch(e) { res.status(400).send("Could not update subscription."); }
});
app.post("/admin/ride-update", requireLogin, async (req,res) => {
  if(currentUser(req).role!=="admin") return res.status(403).send("Forbidden");
  const allowed=["requested","accepted","driver_arrived","in_progress","completed","cancelled"];
  if(!allowed.includes(req.body.status)) return res.status(400).send("Invalid ride status.");
  try {
    const id=new ObjectId(req.body.id); const update={status:req.body.status,updatedAt:new Date(),updatedBy:currentUser(req).id};
    if(req.body.finalFareNGN!==undefined && req.body.finalFareNGN!=="") {
      const fare=Number(req.body.finalFareNGN); if(!Number.isFinite(fare)||fare<0||fare>10000000) return res.status(400).send("Invalid fare.");
      update.finalFareNGN=Math.round(fare);
      if(req.body.status==="completed") update.commissionNGN=Math.round(fare*Number(await getSetting("commissionPercent",15))/100);
    }
    await db.collection("rides").updateOne({_id:id},{$set:update});
    res.redirect("/admin");
  } catch(e) { res.status(400).send("Could not update ride."); }
});
app.post("/payments/paystack/webhook", express.raw({type:"application/json"}), async (req,res) => {
  try {
    const crypto=require("crypto");
    if(!process.env.PAYSTACK_SECRET_KEY||!Buffer.isBuffer(req.rawBody)) return res.sendStatus(400);
    const signature=crypto.createHmac("sha512",process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest("hex");
    if(signature.length!==String(req.headers["x-paystack-signature"]||"").length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(String(req.headers["x-paystack-signature"]||"")))) return res.sendStatus(401);
    const event=JSON.parse(req.rawBody.toString("utf8"));
    if(event.event==="charge.success"&&event.data?.reference&&db) {
      const payment=await db.collection("payments").findOne({reference:event.data.reference});
      if(payment&&payment.status!=="success"&&Number(event.data.amount)===Math.round(payment.amountNGN*100)&&event.data.currency==="NGN") {
        await db.collection("payments").updateOne({reference:payment.reference,status:{$ne:"success"}},{$set:{status:"success",channel:event.data.channel,paidAt:new Date(),verifiedAt:new Date(),paystackTransactionId:event.data.id}});
        if(payment.type==="ride") { const released=await db.collection("rides").updateOne({_id:new ObjectId(payment.rideId),paymentReference:payment.reference,paymentStatus:{$ne:"paid"}},{$set:{paymentStatus:"paid",status:"requested",paidAt:new Date(),paymentChannel:event.data.channel,updatedAt:new Date()}}); if(released.modifiedCount) await notifyEligibleDriversOfRide(new ObjectId(payment.rideId)); }
        if(payment.type==="cash_commission") {await db.collection("driverLedger").updateOne({_id:new ObjectId(payment.ledgerId),driverId:payment.driverId,paymentStatus:"unpaid"},{$set:{paymentStatus:"paid_pending_admin",commissionPaidAt:new Date(),commissionPaymentReference:payment.reference,updatedAt:new Date()}});}
        if(payment.type==="subscription") {const driverId=new ObjectId(payment.driverId);const driver=await db.collection("driverApplications").findOne({_id:driverId,status:"approved"});if(driver){const days=Number(await getSetting("subscriptionDays",30));await db.collection("driverApplications").updateOne({_id:driverId,status:"approved"},{$set:{subscriptionStatus:"active",subscriptionExpiresAt:new Date(Date.now()+days*86400000),subscriptionPaidAt:new Date(),subscriptionPaymentReference:payment.reference}});}}
      }
    }
    res.sendStatus(200);
  } catch(e) {console.error("Paystack webhook error:",e);res.sendStatus(500);}
});
app.get("/api/push/public-key", requireLogin, (req,res)=>{
  if (!pushConfigured) return res.status(503).json({enabled:false,error:"Push notifications are not configured on the server yet."});
  if (!["customer","driver"].includes(currentUser(req).role)) return res.status(403).json({enabled:false,error:"Push notifications are only available to customers and drivers."});
  res.json({enabled:true,publicKey:process.env.VAPID_PUBLIC_KEY});
});
app.post("/api/push/subscribe", requireLogin, async (req,res)=>{
  try {
    if(!db) return res.status(503).json({error:"Database unavailable."});
    if(!pushConfigured) return res.status(503).json({error:"Push notifications are not configured on the server yet."});
    if(!["customer","driver"].includes(currentUser(req).role)) return res.status(403).json({error:"Customer or driver account required."});
    const sub=req.body?.subscription;
    if(!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !/^https:\/\//.test(sub.endpoint)) return res.status(400).json({error:"Invalid browser push subscription."});
    await db.collection("pushSubscriptions").updateOne({userId:String(currentUser(req).id),"subscription.endpoint":sub.endpoint},{$set:{userId:String(currentUser(req).id),role:currentUser(req).role,subscription:sub,updatedAt:new Date(),userAgent:String(req.get("user-agent")||"").slice(0,300)}},{upsert:true});
    res.json({ok:true,message:"Push notifications enabled on this device."});
  } catch(e) { console.error("Push subscription error:",e); res.status(500).json({error:"Could not save notification settings."}); }
});
app.post("/api/push/unsubscribe", requireLogin, async (req,res)=>{
  try {
    if(!db) return res.status(503).json({error:"Database unavailable."});
    const endpoint=String(req.body?.endpoint||"");
    if(endpoint) await db.collection("pushSubscriptions").deleteOne({userId:String(currentUser(req).id),"subscription.endpoint":endpoint});
    res.json({ok:true});
  } catch(e) {res.status(500).json({error:"Could not disable push notifications."});}
});
app.get("/manifest.webmanifest", (req,res)=>res.sendFile(require("path").join(__dirname,"public","manifest.webmanifest")));
app.get("/service-worker.js", (req,res)=>{res.setHeader("Service-Worker-Allowed","/");res.setHeader("Content-Type","application/javascript; charset=utf-8");res.sendFile(require("path").join(__dirname,"public","service-worker.js"));});
app.get("/health", (req,res)=>res.json({ok:true,app:"Smart Ride",database:!!db}));
async function start() {
  if(MONGO_URI) {
    const client=new MongoClient(MONGO_URI);
    await client.connect();
    db=client.db(DB_NAME);
    await db.collection("users").createIndex({email:1},{unique:true});
    const adminEmail=(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
    if(adminEmail){const adminResult=await db.collection("users").updateOne({email:adminEmail},{$set:{role:"admin"}});if(adminResult.matchedCount) console.log("Configured administrator account ready:",adminEmail);else console.log("ADMIN_EMAIL is set; register that email on SMART RIDE to activate administrator access.");}
    await db.collection("rides").createIndex({customerId:1,createdAt:-1});
    await db.collection("driverApplications").createIndex({email:1,createdAt:-1});
    await db.collection("driverLedger").createIndex({entryType:1,paymentStatus:1,dueAt:1});
    await db.collection("notifications").createIndex({userId:1,read:1,createdAt:-1});
    await db.collection("pushSubscriptions").createIndex({userId:1});
    await db.collection("pushSubscriptions").createIndex({"subscription.endpoint":1},{unique:true});
    await db.collection("driverLedger").createIndex({rideId:1,entryType:1},{unique:true});
    console.log("Connected to MongoDB");
    await recoverMissingCompletedRideLedgers();
    await enforceSmartLock();
    const smartLockWorker=setInterval(async()=>{try{await recoverMissingCompletedRideLedgers();await enforceSmartLock();}catch(e){console.error("Smart Lock worker error:",e);}},60_000);
    smartLockWorker.unref();
  } else console.warn("MONGODB_URI not set; database-backed features will not work.");
  app.listen(PORT,()=>console.log(`Smart Ride listening on ${PORT}`));
}
start().catch(e=>{console.error("Startup failed:",e);process.exit(1);});
