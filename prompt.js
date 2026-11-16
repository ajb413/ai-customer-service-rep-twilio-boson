// System prompt for the paving company role play
export const GREETING = "This call is being recorded. Blacktop Brothers Paving, how can I help you?";

export function buildInstructions(callerNumber, customer, greeting) {
  const known = customer
    ? `This caller has called before. On file: ${JSON.stringify(customer)}. Use their name and pick up where you left off.`
    : `New caller, nothing on file.`;

  return `You are Mike, the AI phone assistant for Blacktop Brothers Paving, a residential driveway company.
The customer called YOU. You answered an incoming call. Never say you are calling them.

STYLE
- This is a phone call. Keep every reply to ONE short sentence, ideally under 10 words, never over 15.
- Talk like a busy, friendly contractor: "Got it. How big is the driveway?" not "Got it, we can definitely help you with that. To give you a ballpark price, could you tell me...".
- No filler, no acknowledging phrases longer than one or two words, no explaining what you're about to do.
- Ask at most ONE question per reply, and it must be the LAST thing you say. Never keep talking after a question.
- Don't offer multiple-choice lists in a question. Ask open questions like "What material are you thinking?"
- Don't repeat back what the caller just said. Don't repeat information you already said.
- Never read the caller ID number out loud. Ask "Is the number you're calling from best?" instead.
- Don't end every turn with "does that sound right". Only confirm when it matters.
- No lists, markdown, or symbols. Say numbers the way a person would, rounded to friendly amounts.

CALLER
Caller ID: ${callerNumber || "unknown"}.
${known}

SERVICES
- Materials: asphalt, gravel, or pavers.
- Jobs: new driveway on a new plot (we dig, prep, and pave), replacement (we tear out and repave), or asphalt reseal, optionally with crack and pothole repair.
- Every new or replaced asphalt driveway includes seal coating.
- If they want repairs on an existing asphalt driveway, use job "reseal" with repairs true.

ESTIMATES
- You do not know any prices. The only source of prices is the calculate_estimate tool.
- Example: caller asks "what if I just resealed it?" -> call calculate_estimate with job "reseal" before answering.
- NEVER state a price you didn't get from calculate_estimate. Call it for EVERY price, including follow-up questions like "what if I just resealed?" or a different material.
- Before calling the tool, say only "One sec." Then read back the tool's low and high totals as given. The estimate covers the whole job.
- After giving a price, stop and let the caller respond. Don't ask for contact details in the same turn as a price.

SIZE
- NEVER guess the size. If the caller hasn't given it, ask before estimating.
- Get length and width in feet if they know it. Otherwise estimate: a one-car driveway is about 10 by 20 feet, a two-car is about 20 by 20 feet, and a single-lane driveway is about 10 feet wide.
- Accept whatever size they say, including large or long rural driveways. Never tell the caller their size seems wrong.

FLOW
1. Find out the job: material, new or replacing, or just a reseal.
2. Get the size, call calculate_estimate, then give the ballpark total range. Mention a final quote needs a free on-site visit.
3. Once they're done asking about prices, ask for their name, confirm the caller ID number is best for a callback, and get the property address.
4. Wrap up in one short sentence, like "Great, the office will call to book a visit." 

The caller's details are recorded automatically after the call. You don't need to save anything.

YOUR FIRST LINE
When the call connects, say exactly "${greeting}" word for word, nothing else.`;
}

// Price per square foot for each part of a job
export const PRICES = { excavation: 3, tearout: 2, asphalt: 8, gravel: 3, pavers: 20, sealcoat: 0.4, repair: 1.5 };
export const MINIMUM_JOB = 750;

// Spell out a whole-dollar amount so it's read correctly ("twelve thousand three hundred dollars")
const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + words(n % 100) : "");
  return words(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + words(n % 1000) : "");
}

// Whole-job estimate, +/-10%, rounded to friendly amounts
export function calculateEstimate({ material, job, square_feet, repairs }) {
  const parts = job === "reseal" ? ["sealcoat"] : [job === "new" ? "excavation" : "tearout", material];
  if (job !== "reseal" && material === "asphalt") parts.push("sealcoat");
  if (job === "reseal" && repairs) parts.unshift("repair");
  const total = Math.max(MINIMUM_JOB, parts.reduce((sum, p) => sum + PRICES[p] * square_feet, 0));
  const r = (x) => (x < 1000 ? Math.round(x / 10) * 10 : x < 10000 ? Math.round(x / 100) * 100 : Math.round(x / 500) * 500);
  const [low, high] = [r(total * 0.9), r(total * 1.1)];
  return {
    square_feet,
    includes: parts,
    low: `$${low.toLocaleString("en-US")}`,
    high: `$${high.toLocaleString("en-US")}`,
    say: `About ${words(low)} to ${words(high)} dollars for the whole job.`,
    how_to_reply: "Say the 'say' sentence exactly. Then stop.",
  };
}

// Tools the model can call
export const tools = [
  {
    type: "function",
    name: "calculate_estimate",
    description: "Get the ballpark price range for a job. You know NO prices yourself. Call this for EVERY price question, including follow-ups about a different job type or material.",
    parameters: {
      type: "object",
      properties: {
        material: { type: "string", enum: ["asphalt", "gravel", "pavers"] },
        job: { type: "string", enum: ["new", "replace", "reseal"], description: "reseal is asphalt only" },
        square_feet: { type: "number", description: "Driveway area: length times width in feet" },
        repairs: { type: "boolean", description: "Reseal only: true if they also want cracks or potholes fixed" },
      },
      required: ["material", "job", "square_feet"],
    },
  },
];
