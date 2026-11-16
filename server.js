// Twilio phone call <-> Higgs Realtime bridge
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { buildInstructions, tools, GREETING, calculateEstimate } from "./prompt.js";
import { loadDb, saveCustomer, extractFromTranscript } from "./memory.js";
import { CallRecorder } from "./recorder.js";
import adminRouter from "./admin.js";

const PORT = process.env.PORT || 3000;
const HIGGS_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";
const VOICE = process.env.VOICE || "marcus";

// --- Whitelist: comma-separated E.164 numbers, e.g. +15551234567,+15557654321 ---
const ALLOWED = (process.env.ALLOWED_NUMBERS || "").split(",").map((n) => n.trim()).filter(Boolean);
const isAllowed = (num) => ALLOWED.includes(num);

// --- Twilio voice webhook: tell Twilio to stream call audio to us ---
const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const from = req.body.From || "";
  if (!isAllowed(from)) {
    console.log(`Rejected call from ${from}`);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Reject /></Response>`);
  }
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media">
      <Parameter name="from" value="${from}" />
    </Stream>
  </Connect>
</Response>`);
});

app.get("/", (_req, res) => res.send("ok"));
app.use("/admin", adminRouter);

const server = app.listen(PORT, () => console.log(`Listening on :${PORT} (voice=${VOICE})`));

// --- Media stream WebSocket ---
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilio) => {
  let streamSid = null;
  let callerNumber = "";
  let higgs = null;
  let ended = false;

  // Playback state: what's playing (for barge-in truncation)
  let currentItemId = null;
  let itemStartedAt = 0;
  let pendingToolOutput = false;

  // Call transcript (both sides) for post-call memory extraction, plus recording for /admin
  const transcript = [];
  let rec = null;
  const itemTimes = {}; // item_id -> seconds into the call, so transcript lines line up with audio

  const callStart = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - callStart) / 1000).toFixed(2)}s]`, ...a);

  // Watchdog: Twilio sends audio every 20ms, so a long gap means the call is gone
  let lastMediaAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastMediaAt > 5000) {
      log("No audio from Twilio for 5s, ending call");
      endCall();
    }
  }, 1000);

  const sendHiggs = (evt) => higgs?.readyState === WebSocket.OPEN && higgs.send(JSON.stringify(evt));
  const sendTwilio = (evt) => twilio.readyState === WebSocket.OPEN && twilio.send(JSON.stringify(evt));

  // --- Paced playback: Higgs sends audio much faster than real time; bursts break the Twilio stream,
  // so queue it and send 20ms frames at real-time pace, at most LEAD_MS ahead of playback ---
  const FRAME = 160; // 20ms of 8kHz mu-law
  const LEAD_MS = 200;
  let queue = []; // pending { buf, itemId }
  let playStart = 0; // when the current run of continuous playback started
  let sentBytes = 0; // bytes sent since playStart

  const pacer = setInterval(() => {
    if (!queue.length) return (playStart = 0);
    if (!playStart) (playStart = Date.now()), (sentBytes = 0);
    while (queue.length && sentBytes < (Date.now() - playStart + LEAD_MS) * 8) {
      const head = queue[0];
      const frame = head.buf.subarray(0, FRAME);
      head.buf = head.buf.subarray(FRAME);
      if (!head.buf.length) queue.shift();
      if (!frame.length) continue;
      if (head.itemId !== currentItemId) {
        currentItemId = head.itemId;
        itemStartedAt = Date.now();
      }
      sendTwilio({ event: "media", streamSid, media: { payload: frame.toString("base64") } });
      const t = rec?.addOut(frame) ?? 0;
      itemTimes[head.itemId] ??= t;
      sentBytes += frame.length;
    }
  }, 10);

  function stopPlayback() {
    queue = [];
    playStart = 0;
    sendTwilio({ event: "clear", streamSid });
    rec?.clearOut();
  }

  function connectHiggs() {
    higgs = new WebSocket(HIGGS_URL, { headers: { Authorization: `Bearer ${process.env.BOSON_API_KEY}` } });

    higgs.on("open", () => {
      const customer = loadDb()[callerNumber];
      log(`Call from ${callerNumber}`, customer ? "(returning)" : "(new)");

      const greeting = customer?.name
        ? GREETING.replace("how can I help you?", `welcome back ${customer.name.split(" ")[0]}, how can I help you?`)
        : GREETING;

      sendHiggs({
        type: "session.update",
        session: {
          model: "higgs-realtime",
          instructions: buildInstructions(callerNumber, customer, greeting),
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: { type: "server_vad", threshold: 0.7, silence_duration_ms: 600 }, // default 0.85 missed short words like a name
              transcription: { model: "higgs-stt-3.1" },
            },
            output: { format: { type: "audio/pcmu" }, voice: VOICE },
          },
          tools,
          tool_choice: "auto",
        },
      });

      // Answer the phone (greeting is in the instructions; that's more reliable than per-response instructions)
      sendHiggs({ type: "response.create" });
    });

    higgs.on("message", (raw) => {
      const evt = JSON.parse(raw);

      switch (evt.type) {
        // Model audio -> caller
        case "response.output_audio.delta":
          if (!evt.delta) break; // Twilio rejects empty media messages
          queue.push({ buf: Buffer.from(evt.delta, "base64"), itemId: evt.item_id });
          break;

        // Caller started talking: stop playback, trim what wasn't heard
        case "input_audio_buffer.speech_started":
          log("speech_started -> clearing playback");
          stopPlayback();
          itemTimes[evt.item_id] = evt.audio_start_ms / 1000;
          if (currentItemId) {
            sendHiggs({
              type: "conversation.item.truncate",
              item_id: currentItemId,
              content_index: 0,
              audio_end_ms: Date.now() - itemStartedAt,
            });
            currentItemId = null;
          }
          break;

        // Tool calls: run them, then let the model continue
        case "response.function_call_arguments.done": {
          let result;
          try {
            const args = JSON.parse(evt.arguments || "{}");
            if (evt.name === "calculate_estimate") {
              result = calculateEstimate(args);
              saveCustomer(callerNumber, {
                job_description: `${args.job} ${args.material}, ${args.square_feet} sq ft`,
                estimate: `${result.low} to ${result.high}`,
              });
            } else {
              result = { ok: false, error: `unknown tool ${evt.name}` };
            }
            log(`Tool ${evt.name}:`, JSON.stringify(args), "->", JSON.stringify(result));
          } catch (e) {
            result = { ok: false, error: e.message };
          }
          sendHiggs({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: evt.call_id, output: JSON.stringify(result) },
          });
          pendingToolOutput = true;
          break;
        }

        // After a tool-call response finishes, have the model continue talking
        case "response.done":
          if (pendingToolOutput) {
            pendingToolOutput = false;
            sendHiggs({ type: "response.create" });
          }
          break;

        case "conversation.item.input_audio_transcription.completed":
          log("Caller:", evt.transcript);
          transcript.push(`Caller: ${evt.transcript}`);
          rec?.line("Caller", evt.transcript, itemTimes[evt.item_id] ?? rec.now);
          break;

        case "response.output_audio_transcript.done":
          log("Agent:", evt.transcript);
          transcript.push(`Agent: ${evt.transcript}`);
          rec?.line("Agent", evt.transcript, itemTimes[evt.item_id] ?? rec.now);
          break;

        case "error":
          log("Higgs error:", JSON.stringify(evt));
          break;
      }
    });

    higgs.on("close", (code, reason) => {
      log("Higgs closed", code, reason.toString());
      twilio.close();
    });
    higgs.on("error", (e) => log("Higgs ws error:", e.message));
  }

  // After hangup: extract details from the transcript as a backup to the tool
  async function endCall() {
    if (ended) return;
    ended = true;
    clearInterval(watchdog);
    clearInterval(pacer);
    higgs?.close();
    twilio.close();
    rec?.finish();
    if (!callerNumber || transcript.length < 2) return;
    try {
      const ex = await extractFromTranscript(transcript.join("\n"));
      const saved = saveCustomer(callerNumber, { ...ex, phone: ex.phone || callerNumber });
      console.log("Post-call saved customer:", JSON.stringify(saved));
    } catch (e) {
      console.error("Post-call extraction failed:", e.message);
    }
  }

  twilio.on("message", (raw) => {
    const msg = JSON.parse(raw);
    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        callerNumber = msg.start.customParameters?.from || "";
        if (!isAllowed(callerNumber)) return twilio.close();
        rec = new CallRecorder(msg.start.callSid, callerNumber);
        connectHiggs();
        break;
      case "media":
        lastMediaAt = Date.now();
        sendHiggs({ type: "input_audio_buffer.append", audio: msg.media.payload });
        rec?.addIn(Buffer.from(msg.media.payload, "base64"));
        break;
      case "stop":
        log("Twilio stop event");
        endCall();
        break;
    }
  });

  twilio.on("close", endCall);
});
