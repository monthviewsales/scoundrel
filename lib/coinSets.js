const SOL_MINT = process.env.SOL_MINT || 'So11111111111111111111111111111111111111111';

function mintFromRow(row) {
    // Your parsed rows already set `mint` to the token (not SOL), so just guard:
    return row?.mint && row.mint !== SOL_MINT ? row.mint : null;
}

function getRecentMints(parsedRows = [], { count = 10, solMint = SOL_MINT } = {}) {
    const rows = Array.isArray(parsedRows) ? parsedRows : [];
    const seen = new Set();
    const out = [];
    for (const r of rows.slice().sort((a, b) => b.ts - a.ts)) {
        const m = r?.mint && r.mint !== solMint ? r.mint : null;
        if (!m) continue;
        if (!seen.has(m)) {
            seen.add(m);
            out.push(m);
            if (out.length >= count) break;
        }
    }
    return out;
}

function groupRowsByMint(parsedRows = [], mints = []) {
    const set = new Set(mints);
    const groups = new Map();
    for (const m of mints) groups.set(m, []);
    for (const r of parsedRows) {
        const m = mintFromRow(r);
        if (m && set.has(m)) groups.get(m).push(r);
    }
    for (const [m, arr] of groups) arr.sort((a, b) => a.ts - b.ts);
    return groups;
}

module.exports = { getRecentMints, groupRowsByMint, SOL_MINT };
