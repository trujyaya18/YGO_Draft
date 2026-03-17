const express = require("express");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const { sets } = JSON.parse(fs.readFileSync("./cards.json", "utf8"));
const setMap = new Map(sets.map(s => [s.id, s]));

// ---------------------------------------------------------------------------
// Box / Pack logic
// ---------------------------------------------------------------------------

// Standard TCG booster pack composition for YGO:
//   9 Commons, 3 Rares, 1 foil slot (Super / Ultra / Secret)
// A "box" of 24 packs guarantees a realistic distribution of foils.
// We pre-build the box pool so every foil slot is drawn without replacement,
// making the distribution faithful to real box ratios.

const PACK_COMMONS  = 7;
const PACK_RARES    = 1;  // always get at least 1 Rare (could be the foil too)
const BOX_SIZE      = 24; // canonical box size used for ratio math

// Foil rates per box (24 packs):
//   ~1 Secret Rare per 3–4 boxes → ~0.33 per box
//   ~1 Ultra Rare per box
//   ~3 Super Rares per box
// We model this as a pre-seeded foil pool per box.

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function byRarity(cards, rarity) {
  return cards.filter(c => c.rarity === rarity);
}

/**
 * Simulates a booster box for the given set and returns `packCount` packs
 * drawn from it.  If packCount > BOX_SIZE we open multiple boxes.
 */
function generateBoxPacks(set, packCount) {
  const commons  = byRarity(set.cards, "Common");
  const rares    = byRarity(set.cards, "Rare");
  const supers   = byRarity(set.cards, "Super Rare");
  const ultras   = byRarity(set.cards, "Ultra Rare");
  const secrets  = byRarity(set.cards, "Secret Rare");

  // Fallbacks so sets with missing rarities still work
  const foilPool = (arr, fallback) => arr.length ? arr : fallback;

  const allPacks = [];
  let remaining = packCount;

  while (remaining > 0) {
    const boxPacks = Math.min(remaining, BOX_SIZE);
    remaining -= boxPacks;

    // --- Build foil slots for this box ---
    // Scale ratios proportionally when opening fewer than a full box
    const ratio = boxPacks / BOX_SIZE;

    // Secrets: 1 per 3 boxes → ~0.33 per box
    const secretCount = Math.random() < (ratio * 0.33) ? 1 : 0;
    // Ultras: 1 per box
    const ultraCount  = Math.round(ratio * 1);
    // Supers: 3 per box
    const superCount  = Math.max(0, boxPacks - secretCount - ultraCount -
                          Math.round(ratio * (BOX_SIZE - 1 - 3 - 1)));

    const foilSlots = [
      ...Array.from({ length: secretCount }, () =>
        secrets.length ? pickRandom(secrets) : pickRandom(foilPool(ultras, rares))),
      ...Array.from({ length: ultraCount }, () =>
        ultras.length ? pickRandom(ultras) : pickRandom(foilPool(supers, rares))),
      ...Array.from({ length: superCount }, () =>
        supers.length ? pickRandom(supers) : pickRandom(foilPool(ultras, rares))),
    ];

    // Pad remaining slots with rares if needed
    while (foilSlots.length < boxPacks) {
      foilSlots.push(rares.length ? pickRandom(rares) : pickRandom(set.cards));
    }

    const shuffledFoils = shuffle(foilSlots).slice(0, boxPacks);

    // --- Assemble packs ---
    for (let p = 0; p < boxPacks; p++) {
      const pack = [];

      // Commons
      for (let i = 0; i < PACK_COMMONS; i++) {
        pack.push(commons.length ? pickRandom(commons) : pickRandom(set.cards));
      }

      // Base rare slot
      if (rares.length) {
        pack.push(pickRandom(rares));
      }

      // Foil slot (pre-seeded from box pool)
      pack.push(shuffledFoils[p]);

      allPacks.push(pack);
    }
  }

  return allPacks;
}

// ---------------------------------------------------------------------------
// In-memory draft state (single session; extend to Map keyed by sessionId
// if you want multi-user support)
// ---------------------------------------------------------------------------

let draftState = {
  packs:   [],
  drafted: [],
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/sets", (_req, res) => {
  res.json(sets.map(s => ({ id: s.id, name: s.name || s.id })));
});

app.post("/api/startDraft", (req, res) => {
  const { configuration } = req.body;

  if (!Array.isArray(configuration) || configuration.length === 0) {
    return res.status(400).json({ error: "configuration must be a non-empty array" });
  }

  draftState.packs   = [];
  draftState.drafted = [];

  for (const { set: setId, packs } of configuration) {
    const set = setMap.get(setId);
    if (!set) return res.status(400).json({ error: `Unknown set: ${setId}` });
    if (!Number.isInteger(packs) || packs < 1) {
      return res.status(400).json({ error: `Invalid pack count for set ${setId}` });
    }
    draftState.packs.push(...generateBoxPacks(set, packs));
  }

  // Shuffle across sets so multi-set drafts interleave packs
  draftState.packs = shuffle(draftState.packs);

  res.json({ success: true, totalPacks: draftState.packs.length });
});

app.get("/api/nextPack", (_req, res) => {
  if (draftState.packs.length === 0) return res.json({ done: true });
  res.json({ pack: draftState.packs.shift(), remaining: draftState.packs.length });
});

app.post("/api/pick", (req, res) => {
  const { card } = req.body;
  if (!card || !card.name) return res.status(400).json({ error: "card required" });
  draftState.drafted.push(card);
  res.json({ success: true, drafted: draftState.drafted.length });
});

app.get("/api/drafted", (_req, res) => res.json(draftState.drafted));

app.listen(PORT, () => console.log(`YGO Draft Simulator running on http://localhost:${PORT}`));
