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

async function validateCandidate(payload) {
    const res = await client.chat.completions.create({
        model: "gpt-5-nano", // fast validator
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: "You are a trade validator. Return JSON only." },
            { role: "user", content: JSON.stringify(payload) }
        ],
    });
    return JSON.parse(res.choices[0].message.content);
}

async function analyzeBatch(rows) {
    const res = await client.chat.completions.create({
        model: "gpt-5-nano", // fast + cheap
        response_format: traderProfileSchema
          ? { type: "json_schema", json_schema: traderProfileSchema }
          : { type: "json_object" },
        messages: [
            { role: "system", content: "Profile this trader from the provided rows. Return ONLY a TraderProfile JSON. If schema not available, return a compact JSON profile." },
            { role: "user", content: JSON.stringify(rows) }
        ],
    });
    return JSON.parse(res.choices[0].message.content);
}

// Build a single Trader Profile using the strict schema if available
async function buildProfile({ traderName, wallet, rows }) {
    const payload = { traderName, wallet, rows };
    const res = await client.chat.completions.create({
        model: "gpt-5-nano",
        response_format: traderProfileSchema
          ? { type: "json_schema", json_schema: traderProfileSchema }
          : { type: "json_object" },
        messages: [
            { role: "system", content: "You are a trading style profiler. Return only a valid TraderProfile JSON." },
            { role: "user", content: JSON.stringify(payload) }
        ],
        temperature: 0.1
    });
    return JSON.parse(res.choices[0].message.content);
}

// Answer questions about a trader using their profile (+ optional rows)
async function answerTraderQuestion({ profile, question, rows = [] }) {
    const payload = { profile, question, rows };
    const res = await client.chat.completions.create({
        model: "gpt-5-nano",
        response_format: traderQASchema
          ? { type: "json_schema", json_schema: traderQASchema }
          : { type: "json_object" },
        messages: [
            { role: "system", content: "Answer concisely using the provided profile and optional rows. Return JSON only conforming to TraderQA." },
            { role: "user", content: JSON.stringify(payload) }
        ],
        temperature: 0.1
    });
    return JSON.parse(res.choices[0].message.content);
}

// Recommend safe, incremental bot tuning based on profile and current settings
async function recommendTuning({ profile, currentSettings, recentPnL }) {
    const payload = { profile, currentSettings, recentPnL };
    const res = await client.chat.completions.create({
        model: "gpt-5-nano",
        response_format: tuningRecommendationSchema
          ? { type: "json_schema", json_schema: tuningRecommendationSchema }
          : { type: "json_object" },
        messages: [
            { role: "system", content: "Map insights to safe, incremental config changes. Return JSON only as TuningRecommendation." },
            { role: "user", content: JSON.stringify(payload) }
        ],
        temperature: 0.1
    });
    return JSON.parse(res.choices[0].message.content);
}

module.exports = { validateCandidate, analyzeBatch, buildProfile, answerTraderQuestion, recommendTuning };