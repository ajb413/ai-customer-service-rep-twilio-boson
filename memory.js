// Customer memory: JSON file keyed by caller ID, plus post-call extraction as a backup to the tool
import fs from "node:fs";
import { WebSocket } from "ws";

const DB_FILE = "./customers.json";

export const loadDb = () => (fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {});

export function saveCustomer(callerNumber, data) {
  const db = loadDb();
  const key = callerNumber || "unknown";
  // Ignore empty values so a partial update doesn't wipe known fields
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v));
  db[key] = { ...db[key], ...clean, last_call: new Date().toISOString() };
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  return db[key];
}

// Ask Higgs (text mode) to pull customer details out of the call transcript
export function extractFromTranscript(transcript) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://api.boson.ai/v1/realtime?model=higgs-realtime", {
      headers: { Authorization: `Bearer ${process.env.BOSON_API_KEY}` },
    });
    const timer = setTimeout(() => (ws.close(), reject(new Error("extract timeout"))), 30000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          model: "higgs-realtime",
          output_modalities: ["text"],
          instructions:
            'Extract customer details from a phone call transcript. Reply with ONLY a JSON object with keys name, phone, address, job_description, estimate, notes. Use "" for unknown. Only fill name if the caller clearly stated their own name (never a greeting like "Hello"). notes is a one-sentence summary of the call.',
        },
      }));
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: transcript }] },
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    });

    ws.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "response.output_text.done") {
        clearTimeout(timer);
        ws.close();
        try {
          resolve(JSON.parse(evt.text.slice(evt.text.indexOf("{"), evt.text.lastIndexOf("}") + 1)));
        } catch (e) {
          reject(new Error(`bad JSON: ${evt.text}`));
        }
      } else if (evt.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(JSON.stringify(evt)));
      }
    });
  });
}
