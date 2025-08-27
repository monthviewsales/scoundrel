require('dotenv').config();
// lib/openaiClient.js
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// --- Schema loading helpers ---
function loadSchema(relPath) {
    const full = path.join(__dirname, 'schemas', relPath);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
}

let traderProfileSchema, traderQASchema, tuningRecommendationSchema;
try {
    traderProfileSchema = loadSchema('traderProfile.schema.json');
} catch (_) { /* optional during early setup */ }
try {
    traderQASchema = loadSchema('traderQA.schema.json');
} catch (_) { /* optional during early setup */ }
try {
    tuningRecommendationSchema = loadSchema('tuningRecommendation.result.schema.json');
} catch (_) { /* optional during early setup */ }

const MODEL = process.env.OPENAI_MODEL_VALIDATOR || "gpt-5-nano";

function rfSchema(name, schemaObj) {
  return { type: "json_schema", json_schema: { name, schema: schemaObj, strict: true } };
}

function baseOpts() {
  // gpt-5-nano only supports default generation params; don't send temperature/top_p
  return {};
}

async function validateCandidate(payload) {
    const res = await client.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: "You are a trade validator. Return JSON only." },
            { role: "user", content: JSON.stringify(payload) }
        ],
        ...baseOpts()
    });
    return JSON.parse(res.choices[0].message.content);
}

async function analyzeBatch(rows) {
    const res = await client.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: "You are a trading style profiler. Return compact JSON mapping each row to {traderName, wallet, mint, decision, reasons[]}." },
            { role: "user", content: JSON.stringify(rows) }
        ],
        ...baseOpts()
    });
    return JSON.parse(res.choices[0].message.content);
}

async function buildProfile({ traderName, wallet, rows }) {
    const payload = { traderName, wallet, rows };
    const res = await client.chat.completions.create({
        model: MODEL,
        response_format: traderProfileSchema
          ? rfSchema("TraderProfile", traderProfileSchema)
          : { type: "json_object" },
        messages: [
            { 
                role: "system", 
                content: [
                    "You are a trading quant specializing in Solana memecoins.",
                    "Analyze the provided wallet trade rows to build a TraderProfile JSON.",
                    "Focus on surfacing patterns that give ALPHA to replicate this trader’s edge:",
                    "",
                    "- Capture entry/exit signals (price action, liquidity shifts, timing behavior).",
                    "- Identify position sizing logic (relative to liquidity, volatility, or SOL balance).",
                    "- Map out risk filters (liquidity floors, spread ceilings, rug-avoidance heuristics).",
                    "- Highlight time-based behaviors (active hours, hold duration distributions, cooldowns, weekends vs weekdays).",
                    "- Note strategic tags (e.g., frontrunner, dip-buyer, pumpfun sniping, arb style).",
                    "- Provide at least 2 concrete example trades with mint, ts, and reasoning.",
                    "",
                    "Return ONLY valid TraderProfile JSON according to the schema."
                ].join("\n")
            },
            { role: "user", content: JSON.stringify(payload) }
        ],
        ...baseOpts()
    });
    return JSON.parse(res.choices[0].message.content);
}

async function answerTraderQuestion({ profile, question, rows = [] }) {
    const payload = { profile, question, rows };
    const res = await client.chat.completions.create({
        model: MODEL,
        response_format: traderQASchema
          ? rfSchema("TraderQA", traderQASchema)
          : { type: "json_object" },
        messages: [
            { role: "system", content: "Answer concisely using the profile and optional rows. Return TraderQA JSON only." },
            { role: "user", content: JSON.stringify(payload) }
        ],
        ...baseOpts()
    });
    return JSON.parse(res.choices[0].message.content);
}

async function recommendTuning({ profile, currentSettings, recentPnL }) {
    const payload = { profile, currentSettings, recentPnL };
    const res = await client.chat.completions.create({
        model: MODEL,
        response_format: tuningRecommendationSchema
          ? rfSchema("TuningRecommendation", tuningRecommendationSchema)
          : { type: "json_object" },
        messages: [
            { role: "system", content: "Map insights to safe, incremental config changes. Return TuningRecommendation JSON only." },
            { role: "user", content: JSON.stringify(payload) }
        ],
        ...baseOpts()
    });
    return JSON.parse(res.choices[0].message.content);
}

module.exports = { validateCandidate, analyzeBatch, buildProfile, answerTraderQuestion, recommendTuning };