const { validateCandidate } = require('./lib/openaiClient');

(async () => {
    const verdict = await validateCandidate({
        candidate: { mint: "EXAMPLE", size: 0.1, side: "buy" },
        live: { liquidity: 100000, spread: 0.8, poolAgeMin: 30 },
        profile: { style: "momentum", similarity: 0.71 },
        limits: { maxSizePct: 0.5 },
    });
    console.log(verdict);
})();