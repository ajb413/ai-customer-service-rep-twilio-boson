// Records a call to calls/<callSid>.json (metadata + transcript) and calls/<callSid>.wav (left = caller, right = agent)
import fs from "node:fs";

export const CALLS_DIR = "./calls";
const RATE = 8000;

function ulawDecode(u) {
  u = ~u & 0xff;
  const x = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
  return u & 0x80 ? -x : x;
}

export class CallRecorder {
  constructor(callSid, from) {
    fs.mkdirSync(CALLS_DIR, { recursive: true });
    this.path = `${CALLS_DIR}/${callSid}`;
    this.meta = { callSid, from, started_at: new Date().toISOString(), ended_at: null, transcript: [] };
    this.inChunks = [];
    this.inLen = 0; // inbound samples received = the call's clock
    this.out = Buffer.alloc(RATE * 60, 0xff); // agent track, mu-law silence
    this.outLen = 0;
    this.outPos = 0; // where the next agent chunk will play
    this.save();
  }

  // Seconds since the call started (based on inbound audio)
  get now() {
    return this.inLen / RATE;
  }

  addIn(buf) {
    this.inChunks.push(buf);
    this.inLen += buf.length;
  }

  // Agent audio queues up after whatever is already playing
  addOut(buf) {
    const pos = Math.max(this.outPos, this.inLen);
    if (pos + buf.length > this.out.length) {
      const bigger = Buffer.alloc((pos + buf.length) * 2, 0xff);
      this.out.copy(bigger);
      this.out = bigger;
    }
    buf.copy(this.out, pos);
    this.outPos = pos + buf.length;
    this.outLen = Math.max(this.outLen, this.outPos);
    return pos / RATE; // start time of this chunk
  }

  // Barge-in: anything queued past "now" was never heard
  clearOut() {
    if (this.outLen > this.inLen) this.out.fill(0xff, this.inLen, this.outLen);
    this.outLen = Math.min(this.outLen, this.inLen);
    this.outPos = this.inLen;
  }

  line(role, text, t) {
    this.meta.transcript.push({ t: Math.round(t * 10) / 10, role, text });
    this.meta.transcript.sort((a, b) => a.t - b.t);
    this.save();
  }

  save() {
    fs.writeFileSync(`${this.path}.json`, JSON.stringify(this.meta, null, 2));
  }

  finish() {
    this.meta.ended_at = new Date().toISOString();
    this.save();

    // Stereo 16-bit PCM WAV
    const inBuf = Buffer.concat(this.inChunks);
    const n = Math.max(inBuf.length, this.outLen);
    const pcm = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      pcm.writeInt16LE(i < inBuf.length ? ulawDecode(inBuf[i]) : 0, i * 4);
      pcm.writeInt16LE(i < this.outLen ? ulawDecode(this.out[i]) : 0, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(2, 22); // stereo
    h.writeUInt32LE(RATE, 24);
    h.writeUInt32LE(RATE * 4, 28);
    h.writeUInt16LE(4, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(`${this.path}.wav`, Buffer.concat([h, pcm]));
  }
}
