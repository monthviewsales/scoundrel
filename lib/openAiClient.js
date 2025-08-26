require('dotenv').config();
// lib/openaiClient.js
const OpenAI = require('openai');

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

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

module.exports = { validateCandidate };