require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const dataDir = path.resolve(path.dirname(process.env.DATABASE_PATH || "./data/voxpulse.sqlite"));
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/voxpulse.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS campaigns (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'IDT',
 message TEXT NOT NULL DEFAULT '', lead_list TEXT NOT NULL DEFAULT '', caller_id TEXT NOT NULL DEFAULT '',
 channels INTEGER NOT NULL DEFAULT 1, ring_time INTEGER NOT NULL DEFAULT 30, answer_time INTEGER NOT NULL DEFAULT 120,
 status TEXT NOT NULL DEFAULT 'stopped', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_dial_at TEXT
);
CREATE TABLE IF NOT EXISTS leads (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, phone TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(campaign_id, phone), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS sip_providers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL UNIQUE,
 host TEXT NOT NULL,
 port INTEGER NOT NULL DEFAULT 5060,
 transport TEXT NOT NULL DEFAULT 'udp',
 username TEXT NOT NULL DEFAULT '',
 secret_enc TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS do_not_call (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 phone TEXT NOT NULL UNIQUE,
 reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);


const sessionSecret = process.env.SESSION_SECRET || "";
const passwordHash = process.env.ADMIN_PASSWORD_HASH || "";
const authReady = sessionSecret.length >= 32 && passwordHash.startsWith("$2");
app.disable("x-powered-by");
// Trust the local reverse proxy so secure session cookies work behind HTTPS.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: "1mb" }));
app.use(session({
 store: new SQLiteStore({ db: "sessions.sqlite", dir: "./data" }),
 name: "voxpulse.sid", secret: sessionSecret || "unsafe-development-secret-change-me",
 resave: false, saveUninitialized: false,
 cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const ivrUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const ivrDir = path.join(__dirname, "public", "uploads", "ivr");
fs.mkdirSync(ivrDir, { recursive: true });
for (const [column, definition] of [["caller_ids", "TEXT NOT NULL DEFAULT '[]'"], ["ivr_path", "TEXT NOT NULL DEFAULT ''"]]) {
 try { db.exec("ALTER TABLE campaigns ADD COLUMN " + column + " " + definition); }
 catch (e) { if (!String(e.message).includes("duplicate column")) throw e; }
}

function requireAuth(req, res, next) {
 if (!req.session.user) return res.status(401).json({ error: "Please sign in." });
 next();
}
function audit(campaignId, kind, detail = "") {
 db.prepare("INSERT INTO events(campaign_id,kind,detail) VALUES(?,?,?)").run(campaignId || null, kind, String(detail).slice(0, 300));
}
function cleanText(v, max = 120) { return String(v ?? "").trim().slice(0, max); }
function safeCampaign(row) { return row; }
function parseCallerIds(value, fallback = "") {
 let list = Array.isArray(value) ? value : (String(value ?? fallback).trim().startsWith("[") ? (() => { try { return JSON.parse(value ?? fallback); } catch { return []; } })() : String(value ?? fallback).split(/[\\n,;]+/));
 return [...new Set(list.map(x => String(x || "").trim().replace(/[\\s().-]/g, "")).filter(x => /^\\+?[0-9]{7,15}$/.test(x)))].slice(0,100);
}
function campaignApi(row) {
 if (!row) return row;
 let ids=[]; try { ids=JSON.parse(row.caller_ids || "[]"); } catch {}
 return {...row, caller_ids: ids.length ? ids : (row.caller_id ? [row.caller_id] : []), ivr_url: row.ivr_path || ""};
}

app.get("/api/health", (_req, res) => res.json({ ok: true, callsEnabled: process.env.CALLS_ENABLED === "true", version: "0.1.0" }));
app.get("/api/session", (req, res) => res.json({ authenticated: !!req.session.user, username: req.session.user || null, setupRequired: !authReady }));

app.post("/api/login", rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
 if (!authReady) return res.status(503).json({ error: "Setup required: configure SESSION_SECRET and ADMIN_PASSWORD_HASH in .env, then restart." });
 const username = cleanText(req.body?.username, 80);
 const password = String(req.body?.password || "");
 if (username !== (process.env.ADMIN_USERNAME || "admin") || !await bcrypt.compare(password, passwordHash)) {
   return res.status(401).json({ error: "Invalid username or password." });
 }
 req.session.regenerate(err => {
   if (err) return res.status(500).json({ error: "Could not start session." });
   req.session.user = username;
   res.json({ ok: true, username });
 });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => { res.clearCookie("voxpulse.sid"); res.json({ ok: true }); }));

app.get("/api/summary", requireAuth, (_req, res) => {
 const campaigns = db.prepare("SELECT * FROM campaigns ORDER BY id DESC").all();
 const leads = db.prepare("SELECT COUNT(*) AS total, SUM(status='answered') AS answered, SUM(status='failed') AS failed FROM leads").get();
 res.json({ campaigns, stats: { campaigns: campaigns.length, running: campaigns.filter(c => c.status === "running").length, leads: leads.total || 0, answered: leads.answered || 0, failed: leads.failed || 0, activeCalls: 0, channels: 0 }, callsEnabled: process.env.CALLS_ENABLED === "true" });
});
app.post("/api/campaigns", requireAuth, (req, res) => {
 const b = req.body || {};
 const name = cleanText(b.name, 100);
 if (!name) return res.status(400).json({ error: "Campaign name is required." });
 const channels = Number(b.channels || 1);
 const ring = Number(b.ring_time || 30);
 const answer = Number(b.answer_time || 120);
 const max = Math.max(1, Math.min(500, Number(process.env.MAX_CHANNELS_PER_CAMPAIGN || 10)));
 if (!Number.isInteger(channels) || channels < 1 || channels > max) return res.status(400).json({ error: `Channels must be between 1 and ${max} for this server configuration.` });
 if (!Number.isInteger(ring) || ring < 5 || ring > 120 || !Number.isInteger(answer) || answer < 1 || answer > 7200) return res.status(400).json({ error: "Ring time must be 5–120 seconds; answer time 1–7200 seconds." });
 const callerIds = parseCallerIds(b.caller_ids ?? b.caller_id);
 if ((b.caller_ids || b.caller_id) && !callerIds.length) return res.status(400).json({error:"Enter valid caller IDs (7–15 digits, optional +), separated by commas or new lines."});
 const info = db.prepare("INSERT INTO campaigns(name,provider,message,lead_list,caller_id,caller_ids,channels,ring_time,answer_time) VALUES(?,?,?,?,?,?,?,?,?)")
 .run(name, cleanText(b.provider || "IDT", 80), cleanText(b.message, 160), cleanText(b.lead_list, 160), callerIds[0] || "", JSON.stringify(callerIds), channels, ring, answer);
 audit(info.lastInsertRowid, "campaign_created", name);
 res.status(201).json(campaignApi(db.prepare("SELECT * FROM campaigns WHERE id=?").get(info.lastInsertRowid)));
});
app.patch("/api/campaigns/:id", requireAuth, (req, res) => {
 const id = Number(req.params.id);
 const old = db.prepare("SELECT * FROM campaigns WHERE id=?").get(id);
 if (!old) return res.status(404).json({ error: "Campaign not found." });
 const b = req.body || {};
 const channels = b.channels === undefined ? old.channels : Number(b.channels);
 const ring = b.ring_time === undefined ? old.ring_time : Number(b.ring_time);
 const answer = b.answer_time === undefined ? old.answer_time : Number(b.answer_time);
 const max = Math.max(1, Math.min(500, Number(process.env.MAX_CHANNELS_PER_CAMPAIGN || 10)));
 if (!Number.isInteger(channels) || channels < 1 || channels > max || !Number.isInteger(ring) || ring < 5 || ring > 120 || !Number.isInteger(answer) || answer < 1 || answer > 7200) return res.status(400).json({ error: "Invalid channel or timer value." });
 const name = cleanText(b.name ?? old.name, 100);
 if (!name) return res.status(400).json({ error: "Campaign name is required." });
 const callerIds = b.caller_ids === undefined && b.caller_id === undefined ? parseCallerIds(old.caller_ids, old.caller_id) : parseCallerIds(b.caller_ids ?? b.caller_id);
 if ((b.caller_ids || b.caller_id) && !callerIds.length) return res.status(400).json({error:"Enter valid caller IDs (7–15 digits, optional +), separated by commas or new lines."});
 db.prepare("UPDATE campaigns SET name=?,provider=?,message=?,lead_list=?,caller_id=?,caller_ids=?,channels=?,ring_time=?,answer_time=? WHERE id=?")
 .run(name, cleanText(b.provider ?? old.provider, 80), cleanText(b.message ?? old.message, 160), cleanText(b.lead_list ?? old.lead_list, 160), callerIds[0] || "", JSON.stringify(callerIds), channels, ring, answer, id);
 audit(id, "campaign_updated", name);
 res.json(campaignApi(db.prepare("SELECT * FROM campaigns WHERE id=?").get(id)));
});
app.post("/api/campaigns/:id/action", requireAuth, (req, res) => {
 const id = Number(req.params.id), action = cleanText(req.body?.action, 20);
 const campaign = db.prepare("SELECT * FROM campaigns WHERE id=?").get(id);
 if (!campaign) return res.status(404).json({ error: "Campaign not found." });
 // Outbound origination is deliberately not wired in this scaffold; no calls or provider credit can be consumed.
 if (action === "start") return res.status(409).json({ error: "Dialing is locked in this starter build. Configure consent/DND checks, AMI, provider routing and call controls before enabling live calls." });
 if (action === "stop") {
   db.prepare("UPDATE campaigns SET status='stopped' WHERE id=?").run(id);
   audit(id, "campaign_stopped");
 } else if (action === "reset") {
   db.prepare("UPDATE campaigns SET status='stopped',last_dial_at=NULL WHERE id=?").run(id);
   audit(id, "campaign_reset");
 } else if (action === "delete") {
   db.prepare("DELETE FROM leads WHERE campaign_id=?").run(id);
   db.prepare("DELETE FROM campaigns WHERE id=?").run(id);
   audit(id, "campaign_deleted", campaign.name);
   return res.json({ ok: true });
 } else return res.status(400).json({ error: "Unsupported action." });
 res.json(db.prepare("SELECT * FROM campaigns WHERE id=?").get(id));
});
app.post("/api/campaigns/:id/ivr", requireAuth, ivrUpload.single("file"), (req,res) => {
 const id=Number(req.params.id), c=db.prepare("SELECT id,ivr_path FROM campaigns WHERE id=?").get(id);
 if(!c) return res.status(404).json({error:"Campaign not found."});
 if(!req.file) return res.status(400).json({error:"Choose an audio file."});
 const ext=({"audio/mpeg":".mp3","audio/wav":".wav","audio/x-wav":".wav","audio/ogg":".ogg","audio/mp4":".m4a","audio/aac":".aac"})[req.file.mimetype];
 if(!ext) return res.status(400).json({error:"Use MP3, WAV, OGG, M4A or AAC audio."});
 const filename="campaign-"+id+"-"+crypto.randomBytes(8).toString("hex")+ext;
 fs.writeFileSync(path.join(ivrDir,filename),req.file.buffer,{flag:"wx",mode:0o640});
 const url="/uploads/ivr/"+filename;
 db.prepare("UPDATE campaigns SET ivr_path=? WHERE id=?").run(url,id);
 audit(id,"ivr_audio_uploaded",filename);
 res.json({ok:true,ivr_url:url});
});
app.post("/api/campaigns/:id/leads", requireAuth, upload.single("file"), (req, res) => {
 const id = Number(req.params.id);
 if (!db.prepare("SELECT id FROM campaigns WHERE id=?").get(id)) return res.status(404).json({ error: "Campaign not found." });
 if (!req.file) return res.status(400).json({ error: "Upload a CSV file." });
 let rows;
 try { rows = parse(req.file.buffer.toString("utf8"), { bom: true, skip_empty_lines: true, relax_column_count: true }); }
 catch { return res.status(400).json({ error: "Could not read CSV. Please upload a valid CSV file." }); }
 if (rows.length < 1) return res.status(400).json({ error: "CSV is empty." });
 const first = rows[0].map(x => String(x).trim().toLowerCase());
 const col = first.findIndex(x => ["phone", "phone_number", "number", "mobile", "telephone"].includes(x));
 const hasHeader = col >= 0;
 const idx = hasHeader ? col : 0;
 const values = rows.slice(hasHeader ? 1 : 0).map(r => String(r[idx] || "").replace(/[\s().-]/g, "")).filter(v => /^\+?[0-9]{7,15}$/.test(v));
 const insert = db.prepare("INSERT OR IGNORE INTO leads(campaign_id,phone) VALUES(?,?)");
 const tx = db.transaction(items => { let added = 0; for (const phone of items) added += insert.run(id, phone).changes; return added; });
 const added = tx([...new Set(values)]);
 audit(id, "leads_imported", `${added} unique leads added`);
 res.json({ ok: true, added, duplicatesOrInvalid: rows.length - (hasHeader ? 1 : 0) - added, note: "Imported leads are queued only. This starter build does not place calls." });
});
app.get("/api/campaigns/:id/leads", requireAuth, (req, res) => {
 const id = Number(req.params.id);
 res.json(db.prepare("SELECT id,phone,status,created_at FROM leads WHERE campaign_id=? ORDER BY id DESC LIMIT 500").all(id));
});
app.get("/api/events", requireAuth, (_req, res) => res.json(db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all()));

// VOXPULSE_MANAGEMENT_API_V1
function encryptionKey() {
 const secret = process.env.SESSION_SECRET || "";
 if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
 return crypto.createHash("sha256").update(secret).digest();
}
function encryptSecret(value) {
 if (!value) return "";
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
 const body = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
 return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function decryptSecret(value) {
 if (!value) return "";
 const b = Buffer.from(value, "base64");
 if (b.length < 29) throw new Error("Stored secret format is invalid.");
 const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), b.subarray(0,12));
 decipher.setAuthTag(b.subarray(12,28));
 return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString("utf8");
}
function setting(key) {
 return db.prepare("SELECT value FROM app_settings WHERE key=?").get(key)?.value || "";
}
function saveSetting(key, value) {
 db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`)
 .run(key, String(value ?? ""));
}
app.get("/api/providers", requireAuth, (_req,res) => {
 res.json(db.prepare("SELECT id,name,host,port,transport,username,created_at,CASE WHEN secret_enc='' THEN 0 ELSE 1 END AS hasSecret FROM sip_providers ORDER BY id DESC").all());
});
app.post("/api/providers", requireAuth, (req,res) => {
 const b=req.body||{}, name=cleanText(b.name,80), host=cleanText(b.host,255);
 const port=Number(b.port||5060), transport=cleanText(b.transport||"udp",8).toLowerCase();
 if(!name||!host||!Number.isInteger(port)||port<1||port>65535)
   return res.status(400).json({error:"Enter a provider name, hostname and valid port."});
 if(!["udp","tcp","tls"].includes(transport))
   return res.status(400).json({error:"Transport must be UDP, TCP or TLS."});
 let secret="";
 try { secret=encryptSecret(String(b.secret||"")); }
 catch(e) { return res.status(503).json({error:e.message}); }
 try {
   const r=db.prepare("INSERT INTO sip_providers(name,host,port,transport,username,secret_enc) VALUES(?,?,?,?,?,?)")
     .run(name,host,port,transport,cleanText(b.username,120),secret);
   audit(null,"provider_created",name);
   res.status(201).json({ok:true,id:r.lastInsertRowid});
 } catch(e) {
   if(String(e.code||"").includes("CONSTRAINT")) return res.status(409).json({error:"A provider with that name already exists."});
   throw e;
 }
});
app.patch("/api/providers/:id", requireAuth, (req,res) => {
 const id=Number(req.params.id), old=db.prepare("SELECT * FROM sip_providers WHERE id=?").get(id);
 if(!old) return res.status(404).json({error:"Provider not found."});
 const b=req.body||{}, name=cleanText(b.name??old.name,80), host=cleanText(b.host??old.host,255);
 const port=Number(b.port??old.port), transport=cleanText(b.transport??old.transport,8).toLowerCase();
 if(!name||!host||!Number.isInteger(port)||port<1||port>65535||!["udp","tcp","tls"].includes(transport))
   return res.status(400).json({error:"Invalid provider settings."});
 let secret=old.secret_enc;
 if(b.secret) { try { secret=encryptSecret(b.secret); } catch(e) { return res.status(503).json({error:e.message}); } }
 try {
  db.prepare("UPDATE sip_providers SET name=?,host=?,port=?,transport=?,username=?,secret_enc=? WHERE id=?")
   .run(name,host,port,transport,cleanText(b.username??old.username,120),secret,id);
  audit(null,"provider_updated",name); res.json({ok:true});
 } catch(e) { if(String(e.code||"").includes("CONSTRAINT")) return res.status(409).json({error:"Provider name already exists."}); throw e; }
});
app.delete("/api/providers/:id", requireAuth, (req,res) => {
 const id=Number(req.params.id), row=db.prepare("SELECT name FROM sip_providers WHERE id=?").get(id);
 if(!row) return res.status(404).json({error:"Provider not found."});
 db.prepare("DELETE FROM sip_providers WHERE id=?").run(id);
 audit(null,"provider_deleted",row.name); res.json({ok:true});
});
app.get("/api/settings", requireAuth, (_req,res) => {
 res.json({
   amiHost:setting("ami_host"), amiPort:setting("ami_port")||"5038",
   amiUsername:setting("ami_username"), hasAmiSecret:!!setting("ami_secret_enc"),
   callsEnabled:false, maxChannels:Number(process.env.MAX_CHANNELS_PER_CAMPAIGN||10),
   mode:"Safe mode"
 });
});
app.put("/api/settings/ami", requireAuth, (req,res) => {
 const b=req.body||{}, host=cleanText(b.host,255), port=Number(b.port||5038), username=cleanText(b.username,120);
 if(!host||!Number.isInteger(port)||port<1||port>65535||!username)
   return res.status(400).json({error:"Enter AMI host, port and username."});
 if(host==="0.0.0.0"||host==="::") return res.status(400).json({error:"Use the actual AMI server address, not a wildcard address."});
 let enc=setting("ami_secret_enc");
 if(b.secret) { try { enc=encryptSecret(b.secret); } catch(e) { return res.status(503).json({error:e.message}); } }
 saveSetting("ami_host",host); saveSetting("ami_port",String(port));
 saveSetting("ami_username",username); if(enc) saveSetting("ami_secret_enc",enc);
 audit(null,"ami_settings_updated","AMI connection settings updated");
 res.json({ok:true,hasAmiSecret:!!enc,note:"Saved. Live dialing remains disabled."});
});
app.post("/api/settings/ami-test", requireAuth, (req,res) => {
 const host=setting("ami_host"), port=Number(setting("ami_port")||5038);
 if(!host) return res.status(400).json({ok:false,error:"Save the AMI host and port first."});
 // This only checks TCP reachability; it does not log in or originate calls.
 const socket=new net.Socket(); let finished=false;
 const finish=(result,status=200)=>{
  if(finished)return; finished=true; socket.destroy(); res.status(status).json(result);
 };
 socket.setTimeout(3000);
 socket.once("connect",()=>finish({ok:true,reachable:true,note:"AMI TCP port is reachable. Authentication and permissions have not yet been verified."}));
 socket.once("timeout",()=>finish({ok:false,error:"Connection timed out. Check host, port and firewall."},504));
 socket.once("error",e=>finish({ok:false,error:"Connection failed: "+(e.code||"network error")},502));
 socket.connect(port,host);
});
app.get("/api/reports", requireAuth, (_req,res) => {
 const totals=db.prepare(`SELECT COUNT(*) total,
 SUM(CASE WHEN status='answered' THEN 1 ELSE 0 END) answered,
 SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
 SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued FROM leads`).get();
 const byCampaign=db.prepare(`SELECT c.id,c.name,c.provider,c.status,c.created_at,
 COUNT(l.id) leads,
 SUM(CASE WHEN l.status='answered' THEN 1 ELSE 0 END) answered,
 SUM(CASE WHEN l.status='failed' THEN 1 ELSE 0 END) failed,
 SUM(CASE WHEN l.status='queued' THEN 1 ELSE 0 END) queued
 FROM campaigns c LEFT JOIN leads l ON l.campaign_id=c.id
 GROUP BY c.id ORDER BY c.id DESC`).all();
 res.json({totals,byCampaign,events:db.prepare("SELECT kind,detail,created_at FROM events ORDER BY id DESC LIMIT 100").all()});
});
app.get("/api/lead-lists", requireAuth, (_req,res) => {
 res.json(db.prepare(`SELECT c.id,c.name AS campaign,c.lead_list AS listName,
 COUNT(l.id) AS total,
 SUM(CASE WHEN l.status='queued' THEN 1 ELSE 0 END) AS queued,
 SUM(CASE WHEN l.status='answered' THEN 1 ELSE 0 END) AS answered,
 SUM(CASE WHEN l.status='failed' THEN 1 ELSE 0 END) AS failed
 FROM campaigns c LEFT JOIN leads l ON l.campaign_id=c.id
 GROUP BY c.id ORDER BY c.id DESC`).all());
});
app.get("/api/dnd", requireAuth, (_req,res) => {
 res.json(db.prepare("SELECT id,phone,reason,created_at FROM do_not_call ORDER BY id DESC LIMIT 1000").all());
});
app.post("/api/dnd", requireAuth, (req,res) => {
 const phone=String(req.body?.phone||"").replace(/[\s().-]/g,"");
 if(!/^\+?[0-9]{7,15}$/.test(phone)) return res.status(400).json({error:"Enter a valid phone number."});
 try { const r=db.prepare("INSERT INTO do_not_call(phone,reason) VALUES(?,?)").run(phone,cleanText(req.body?.reason,200)); audit(null,"dnd_number_added",phone); res.status(201).json({ok:true,id:r.lastInsertRowid}); }
 catch(e) { if(String(e.code||"").includes("CONSTRAINT")) return res.status(409).json({error:"That number is already on the DND list."}); throw e; }
});
app.delete("/api/dnd/:id", requireAuth, (req,res) => {
 const r=db.prepare("DELETE FROM do_not_call WHERE id=?").run(Number(req.params.id));
 if(!r.changes) return res.status(404).json({error:"DND entry not found."});
 audit(null,"dnd_number_removed",String(req.params.id)); res.json({ok:true});
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.use((err, _req, res, _next) => {
 if (err instanceof multer.MulterError) return res.status(400).json({ error: "Upload too large. Maximum CSV size is 5 MB." });
 res.status(500).json({ error: "Unexpected server error." });
});
app.listen(PORT, HOST, () => console.log(`VoxPulse Web Dialer listening on http://${HOST}:${PORT}`));
