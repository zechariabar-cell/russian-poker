// לוגיקת Russian Poker (בסגנון Caribbean Stud): 5 קלפים, Ante, Raise פי 2, דילר מוכשר מ-A-K
const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];

const HAND_NAMES = [
  'קלף גבוה', 'זוג', 'שני זוגות', 'שלשה', 'סטרייט',
  'פלאש', 'פול האוס', 'רביעייה', 'סטרייט פלאש', 'רויאל פלאש',
];

// יחס תשלום על ההעלאה (Raise) לפי דירוג היד של השחקן
const RAISE_PAYOUT = [1, 1, 2, 3, 4, 5, 7, 20, 50, 100];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// מחזיר { cat, tb, name } - cat הוא דירוג היד, tb הוא שובר שוויון
function evaluate(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const uniq = [...new Set(ranks)];
  let straight = false;
  let high = ranks[0];
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straight = true;
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) {
      straight = true;
      high = 5; // A-2-3-4-5
    }
  }
  const counts = {};
  ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([r, n]) => ({ r: +r, n }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  let tb = groups.map((g) => g.r);
  let cat;
  if (straight && flush) {
    cat = high === 14 ? 9 : 8;
    tb = [high];
  } else if (groups[0].n === 4) cat = 7;
  else if (groups[0].n === 3 && groups[1].n === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straight) {
    cat = 4;
    tb = [high];
  } else if (groups[0].n === 3) cat = 3;
  else if (groups[0].n === 2 && groups[1].n === 2) cat = 2;
  else if (groups[0].n === 2) cat = 1;
  else cat = 0;
  return { cat, tb, name: HAND_NAMES[cat] };
}

// היד הטובה ביותר מתוך 5 או 6 קלפים
function best(cards) {
  if (cards.length <= 5) return evaluate(cards);
  let top = null;
  for (let skip = 0; skip < cards.length; skip++) {
    const e = evaluate(cards.filter((_, i) => i !== skip));
    if (!top || compare(e, top) > 0) top = e;
  }
  return top;
}

// יחס תשלום ל-Bonus Bet לפי 5 הקלפים הראשונים
const BONUS_PAYOUT = { 3: 5, 4: 50, 5: 100, 6: 150, 7: 250, 8: 800, 9: 1500 };

function compare(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
    const x = a.tb[i] || 0;
    const y = b.tb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// הדילר מוכשר עם A-K או יד גבוהה יותר
function dealerQualifies(cards) {
  const e = evaluate(cards);
  if (e.cat >= 1) return true;
  const ranks = cards.map((c) => c.r);
  return ranks.includes(14) && ranks.includes(13);
}

// חישוב תוצאה לשחקן אחד. ante = ההימור, raised = האם העלה (פי 2)
// מחזיר { outcome, payout (כמה שבבים חוזרים), bet (כמה הושקע), net }
function settle(playerCards, dealerCards, ante, raised) {
  if (!raised) {
    return { outcome: 'fold', payout: 0, bet: ante, net: -ante };
  }
  const raise = ante * 2;
  const bet = ante + raise;
  const p = best(playerCards);
  const d = evaluate(dealerCards);
  if (!dealerQualifies(dealerCards)) {
    // הדילר לא מוכשר: ה-Ante משלם 1:1 וההעלאה חוזרת
    const payout = ante * 2 + raise;
    return { outcome: 'noqualify', payout, bet, net: payout - bet };
  }
  const cmp = compare(p, d);
  if (cmp > 0) {
    const payout = ante * 2 + raise + raise * RAISE_PAYOUT[p.cat];
    return { outcome: 'win', payout, bet, net: payout - bet };
  }
  if (cmp < 0) return { outcome: 'lose', payout: 0, bet, net: -bet };
  return { outcome: 'push', payout: bet, bet, net: 0 };
}

module.exports = {
  SUITS, HAND_NAMES, RAISE_PAYOUT, BONUS_PAYOUT,
  buildDeck, shuffle, evaluate, best, compare, dealerQualifies, settle,
};
