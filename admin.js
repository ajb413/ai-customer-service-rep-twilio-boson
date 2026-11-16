// /admin dashboard: basic auth, call list, transcripts, audio
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { CALLS_DIR } from "./recorder.js";
import { loadDb } from "./memory.js";

const router = express.Router();
const SID = /^CA[0-9a-f]{32}$/;

// Hide phone numbers (dashboard is shown on screen shares)
const maskText = (s) => String(s ?? "").replace(/\+?\d[\d\s().-]{6,}\d/g, "[number hidden]");
const maskCustomer = (c) => c && Object.fromEntries(Object.entries(c).filter(([k]) => k !== "phone").map(([k, v]) => [k, maskText(v)]));

// --- Basic auth ---
const expected = "Basic " + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");
const hash = (s) => crypto.createHash("sha256").update(s).digest();

router.use((req, res, next) => {
  if (process.env.ADMIN_PASSWORD && crypto.timingSafeEqual(hash(req.headers.authorization || ""), hash(expected))) return next();
  res.set("WWW-Authenticate", 'Basic realm="admin"').status(401).send("Auth required");
});

// --- Page ---
router.get("/", (_req, res) => res.sendFile("admin.html", { root: import.meta.dirname }));

// --- API ---
const readCall = (sid) => JSON.parse(fs.readFileSync(`${CALLS_DIR}/${sid}.json`, "utf8"));

router.get("/api/calls", (_req, res) => {
  const customers = loadDb();
  const files = fs.existsSync(CALLS_DIR) ? fs.readdirSync(CALLS_DIR).filter((f) => f.endsWith(".json")) : [];
  const calls = files.map((f) => {
    const c = readCall(f.slice(0, -5));
    return {
      callSid: c.callSid,
      name: maskText(customers[c.from]?.name) || "Unknown caller",
      started_at: c.started_at,
      ended_at: c.ended_at,
      lines: c.transcript.length,
    };
  });
  res.json(calls.sort((a, b) => b.started_at.localeCompare(a.started_at)));
});

router.get("/api/calls/:sid", (req, res) => {
  if (!SID.test(req.params.sid)) return res.status(400).end();
  const { from, transcript, ...call } = readCall(req.params.sid);
  res.json({
    ...call,
    transcript: transcript.map((l) => ({ ...l, text: maskText(l.text) })),
    customer: maskCustomer(loadDb()[from]),
  });
});

router.get("/audio/:sid", (req, res) => {
  if (!SID.test(req.params.sid)) return res.status(400).end();
  res.sendFile(`${req.params.sid}.wav`, { root: CALLS_DIR });
});

export default router;
