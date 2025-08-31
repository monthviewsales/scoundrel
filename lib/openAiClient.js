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
                    "- Select the TWO most profitable CLOSED trades and return them under signature_trades (maxItems=2).",
                    "  - Each trade must include: mint, buy{ts, size_sol, leg_value_usd, token_unit_price_usd}, sell{ts, size_sol, leg_value_usd, token_unit_price_usd}, pnl_usd, hold_minutes.",
                    "  - Always compute leg_value_usd = size_sol × sol_usd_at_ts using the snapshot; this is required.",
                    "  - token_unit_price_usd is optional and may be null if not available.",
                    "  - Use leg_value_usd (not token_unit_price_usd) when calculating pnl_usd.",
                    "  - Only include trades that have both a buy and a sell leg within the provided rows.",
                    "  - Fee/micro legs: if a row has base.isFeeCandidate === true OR features.is_fee_candidate === true, do NOT select it as the primary buy/sell leg.",
                    "    Instead, ADD its leg_value_usd to the nearest prior primary leg for the same mint and ignore its ts for buy/sell timestamps.",
                    "    When aggregating leg_value_usd, prefer base.legValueUsd if present; otherwise use features.leg_value_usd; if missing, treat as 0.",
                    "    Never invent amounts or timestamps; use only the values present in the provided rows.",
                    "",
                    "MANDATORY AGGREGATION LOGIC:",
                    "- Group all rows by mint (token address). Analyze the FULL sequence per mint (multiple buys/sells) until the position is fully exited (net SOL exposure returns to ~0).",
                    "- For each mint, construct a round-trip by aggregating buys vs sells:",
                    "  - Use features.action_kind and features.round_trip_id to guide aggregation: combine legs within the same round_trip_id.",
                    "  - Treat same-side small follow-up buys as legit scaling (action_kind = 'scale_in'); INCLUDE them in the aggregated BUY total.",
                    "  - Treat quick opposite-side micro legs as fee/micro adjustments ONLY if marked (base.isFeeCandidate OR features.is_fee_candidate).",
                    "  - Do NOT choose fee/micro legs as the primary buy/sell timestamps; use nearest prior primary leg for timestamps.",
                    "  - Sum leg_value_usd and size_sol across all PRIMARY legs per direction within a round_trip_id; ADD fee/micro legs’ leg_value_usd as adjustments to the nearest prior primary leg.",
                    "  - The buy timestamp is the first primary BUY ts; the sell timestamp is the last primary SELL ts for that completed exit.",
                    "  - Ignore mints that do not have both sides (no closed exit).",
                    "- From all CLOSED round-trips across ALL mints, select the TWO with the highest pnl_usd for signature_trades.",
                    "- Compute hold_minutes from first BUY ts to last SELL ts of that mint’s closed sequence.",
                    "- Compute pnl_usd from aggregated leg_value_usd totals: pnl_usd = SUM(sell.leg_value_usd) - SUM(buy.leg_value_usd) within the closed round_trip_id.",
                    "",
                    "POOL TRAIT ANALYSIS (surface actionable patterns in the profile):",
                    "- For each mint’s entries at the time of the first BUY, extract pool traits where available (from snapshot): liquidity_usd, pool_age_min, and any available spread/depth/holders signals.",
                    "- Identify common thresholds and preferences across mints (e.g., typical liquidity floor at entry, preferred pool age, recurring venue/program).",
                    "- Reflect these patterns in risk_profile (liq_floor_usd, spread ceiling if inferable) and in notes as explicit, testable heuristics (≥3 bullets).",
                    "- Update style_tags with pool/venue tendencies (e.g., pumpfun sniping, photon routing, prefers deep liquidity).",
                    "",
                    "BEHAVIOR & TACTICS (with concrete evidence):",
                    "- For each mint, analyze the trader’s exposure timeline (sequence of buys/sells) and classify tactics: initial sizing, same-side scaling (tiny follow-up buys), partial take-profits, quick re-entries, and final exit.",
                    "- Derive cross-mint patterns and surface them as actionable notes (at least 5 bullets).",
                    "- Each note MUST include parenthetical evidence taken from the rows: at least one mint and 2–4 timestamps and sizes that exemplify the pattern. Example: Scales in with ~0.20 SOL follow-ups (e.g., FEELS: buy 09:34:38 0.196; 09:34:44 0.196; TTC: buy 09:43:48 0.196).",
                    "- When noting partial exits and re-entries, explicitly show example legs labeled 'partial sell' and 're-entry' with their ts and size_sol so the behavior is verifiable from data.",
                    "- If multiple tactics occur within ~60s windows, call this out as speed/latency-driven style (include example timestamps).",
                    "",
                    "SCALE:",
                    "- Expect up to ~30 mints with ~10 legs each. You MUST scan all mints, produce per-mint behavior internally, and then return only the TraderProfile JSON (aggregate trends + signature_trades).",
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
