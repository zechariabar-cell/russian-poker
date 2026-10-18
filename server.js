const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const START_CHIPS = 1000;
const MIN_ANTE = 10;
const MAX_PLAYERS = 8;
const SHOWDOWN_MS = 12000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(INDEX).pipe(res);
});

// ---------- חדרים ----------
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      phase: 'betting', // betting | deciding | showdown
      players: [],
      dealer: null, // { cards, eval, qualifies }
      deck: [],
      chat: [],
      nextAt: 0,
      timer: null,
      lastActive: Date.now(),
    });
  }
  return rooms.get(code);
}

function sysChat(room, text) {
  room.chat.push({ sys: true, text, t: Date.now() });
  if (room.chat.length > 60) room.chat.shift();
}

function canPlay(p) {
  return p.chips >= MIN_ANTE * 3;
}

function publicState(room) {
  const showdown = room.phase === 'showdown';
  let dealer = { cards: [], hidden: 0, name: null, qualifies: null };
  if (room.dealer) {
    dealer = showdown
      ? { cards: room.dealer.cards, hidden: 0, name: room.dealer.eval.name, qualifies: room.dealer.qualifies }
      : { cards: [room.dealer.cards[0]], hidden: 4, name: null, qualifies: null };
  }
  return {
    code: room.code,
    phase: room.phase,
    nextAt: room.nextAt,
    minAnte: MIN_ANTE,
    dealer,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      net: p.chips + p.bet + p.extra + p.bonus - START_CHIPS * (1 + p.rebuys),
      bet: p.bet,
      bonus: p.bonus,
      bonusResult: p.bonusResult,
      confirmed: p.confirmed,
      inHand: !!p.hand,
      decision: p.decision,
      drew: p.drew,
      bought: p.bought,
      fees: p.fees,
      hand: p.hand,
      handName: p.hand ? G.best(p.hand).name : null,
      result: p.result,
      connected: !!p.ws && p.ws.readyState === 1,
    })),
    chat: room.chat.slice(-40),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  const state = publicState(room);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type: 'state', you: p.id, state }));
    }
  }
}

function sendError(ws, text) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', text }));
}

// ---------- התקדמות המשחק ----------
function checkProgress(room) {
  if (room.phase === 'betting') {
    const eligible = room.players.filter((p) => p.ws && p.ws.readyState === 1 && canPlay(p));
    const confirmed = room.players.filter((p) => p.confirmed);
    if (confirmed.length > 0 && eligible.every((p) => p.confirmed)) deal(room);
  } else if (room.phase === 'deciding') {
    for (const p of room.players) {
      const online = p.ws && p.ws.readyState === 1;
      if (p.hand && !p.decision && !online) {
        p.decision = 'fold';
      }
    }
    if (room.players.every((p) => !p.hand || p.decision)) showdown(room);
  }
}

function deal(room) {
  room.deck = G.shuffle(G.buildDeck());
  const dealerCards = room.deck.splice(0, 5);
  room.dealer = {
    cards: dealerCards,
    eval: G.evaluate(dealerCards),
    qualifies: G.dealerQualifies(dealerCards),
  };
  for (const p of room.players) {
    p.hand = p.confirmed ? room.deck.splice(0, 5) : null;
    p.decision = null;
    p.result = null;
    p.bonusResult = null;
    p.drew = false;
    p.bought = false;
    p.fees = 0;
    // Bonus Bet נקבע לפי 5 הקלפים הראשונים, ולא תלוי בדילר
    if (p.hand && p.bonus > 0) {
      const e = G.evaluate(p.hand);
      const mult = G.BONUS_PAYOUT[e.cat] || 0;
      if (mult > 0) p.chips += p.bonus * (1 + mult);
      p.bonusResult = {
        bet: p.bonus,
        mult,
        handName: e.name,
        net: mult > 0 ? p.bonus * mult : -p.bonus,
      };
      p.bonus = 0;
    }
  }
  room.phase = 'deciding';
}

// שליפת קלפים מהחפיסה. אם נגמרו, מערבבים מחדש את כל מה שלא נמצא ביד
function drawCards(room, n) {
  if (room.deck.length < n) {
    const used = new Set();
    const key = (c) => c.r + c.s;
    room.dealer.cards.forEach((c) => used.add(key(c)));
    room.players.forEach((p) => p.hand && p.hand.forEach((c) => used.add(key(c))));
    room.deck = G.shuffle(G.buildDeck().filter((c) => !used.has(key(c))));
  }
  return room.deck.splice(0, n);
}

function showdown(room) {
  for (const p of room.players) {
    if (!p.hand) continue;
    const raised = p.decision === 'raise';
    const r = G.settle(p.hand, room.dealer.cards, p.bet, raised);
    p.chips += r.payout;
    const bonusNet = p.bonusResult ? p.bonusResult.net : 0;
    p.result = {
      outcome: r.outcome,
      anteNet: r.net,
      fees: p.fees,
      bonusNet,
      net: r.net - p.fees + bonusNet,
      handName: G.best(p.hand).name,
    };
    p.bet = 0;
    p.extra = 0;
  }
  room.phase = 'showdown';
  room.nextAt = Date.now() + SHOWDOWN_MS;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => newRound(room), SHOWDOWN_MS);
}

function newRound(room) {
  if (room.phase !== 'showdown') return;
  clearTimeout(room.timer);
  room.phase = 'betting';
  room.dealer = null;
  room.nextAt = 0;
  for (const p of room.players) {
    p.hand = null;
    p.decision = null;
    p.result = null;
    p.confirmed = false;
    p.bet = 0;
    p.extra = 0;
    p.bonus = 0;
    p.bonusResult = null;
    p.fees = 0;
    p.drew = false;
    p.bought = false;
  }
  broadcast(room);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

wss.on('connection', (ws) => {
  ws.ctx = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== 'object' || !msg) return;

    if (msg.type === 'join') return handleJoin(ws, msg);
    if (!ws.ctx) return;
    const { room, player } = ws.ctx;

    switch (msg.type) {
      case 'ante': {
        if (room.phase !== 'betting' || player.confirmed) return;
        const amount = Math.floor(Number(msg.amount));
        if (!Number.isFinite(amount) || amount < MIN_ANTE) return sendError(ws, `הימור מינימלי: ${MIN_ANTE}`);
        const bonus = Math.floor(Number(msg.bonus) || 0);
        if (bonus !== 0 && bonus < MIN_ANTE) return sendError(ws, `Bonus מינימלי: ${MIN_ANTE}`);
        if (amount * 3 + bonus > player.chips) {
          return sendError(ws, 'צריך שבבים גם ל-Raise (פי 2) ול-Bonus. הקטן את ההימור.');
        }
        player.chips -= amount + bonus;
        player.bet = amount;
        player.bonus = bonus;
        player.confirmed = true;
        break;
      }
      case 'unante': {
        if (room.phase !== 'betting' || !player.confirmed) return;
        player.chips += player.bet + player.bonus;
        player.bet = 0;
        player.bonus = 0;
        player.confirmed = false;
        break;
      }
      case 'draw': {
        if (room.phase !== 'deciding' || !player.hand || player.decision || player.drew) return;
        const idx = Array.isArray(msg.indices) ? [...new Set(msg.indices.map(Number))] : [];
        if (!idx.length || idx.length > 5 || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= player.hand.length)) {
          return sendError(ws, 'בחר בין 1 ל-5 קלפים להחלפה');
        }
        // חייבים להישאר עם שבבים ל-Raise אחרי התשלום
        if (player.chips - player.bet < player.bet * 2) return sendError(ws, 'אין מספיק שבבים להחלפה ועדיין להעלות');
        player.chips -= player.bet;
        player.fees += player.bet;
        const fresh = drawCards(room, idx.length);
        idx.forEach((i, k) => { player.hand[i] = fresh[k]; });
        player.drew = true;
        break;
      }
      case 'buy': {
        if (room.phase !== 'deciding' || !player.hand || player.decision || player.bought) return;
        if (player.chips - player.bet < player.bet * 2) return sendError(ws, 'אין מספיק שבבים לקלף שישי ועדיין להעלות');
        player.chips -= player.bet;
        player.fees += player.bet;
        player.hand.push(...drawCards(room, 1));
        player.bought = true;
        break;
      }
      case 'dealnow': {
        if (room.phase !== 'betting' || !player.confirmed) return;
        deal(room);
        break;
      }
      case 'decide': {
        if (room.phase !== 'deciding' || !player.hand || player.decision) return;
        if (msg.action === 'raise') {
          if (player.chips < player.bet * 2) return sendError(ws, 'אין מספיק שבבים ל-Raise');
          player.chips -= player.bet * 2;
          player.extra = player.bet * 2;
          player.decision = 'raise';
        } else {
          player.decision = 'fold';
        }
        break;
      }
      case 'next': {
        if (room.phase === 'showdown') newRound(room);
        return;
      }
      case 'rebuy': {
        if (room.phase !== 'betting' || player.confirmed || player.chips >= MIN_ANTE * 3) return;
        player.chips += START_CHIPS;
        player.rebuys += 1;
        sysChat(room, `${player.name} קיבל/ה ${START_CHIPS} שבבים חדשים`);
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
        if (!text) return;
        room.chat.push({ name: player.name, text, t: Date.now() });
        if (room.chat.length > 60) room.chat.shift();
        break;
      }
      default:
        return;
    }
    checkProgress(room);
    broadcast(room);
  });

  ws.on('close', () => {
    if (!ws.ctx) return;
    const { room, player } = ws.ctx;
    if (player.ws === ws) {
      player.ws = null;
      sysChat(room, `${player.name} התנתק/ה`);
      checkProgress(room);
      broadcast(room);
    }
  });
});

function handleJoin(ws, msg) {
  let code = String(msg.room || '').trim();
  if (!/^[A-Za-z0-9א-ת]{2,12}$/.test(code)) return sendError(ws, 'קוד חדר: 2-12 אותיות או ספרות');
  code = code.toUpperCase();
  const name = cleanName(msg.name);
  if (!name) return sendError(ws, 'צריך להזין כינוי');
  const token = String(msg.token || '').slice(0, 64);
  if (!token) return;

  const room = getRoom(code);
  let player = room.players.find((p) => p.token === token);

  if (player) {
    if (player.ws && player.ws !== ws) {
      player.ws.ctx = null;
      player.ws.close();
    }
    player.ws = ws;
    sysChat(room, `${player.name} חזר/ה לשולחן`);
  } else {
    if (room.players.length >= MAX_PLAYERS) {
      const idx = room.players.findIndex((p) => !p.ws && !p.hand && !p.confirmed);
      if (idx === -1) return sendError(ws, 'השולחן מלא (עד 8 שחקנים)');
      room.players.splice(idx, 1);
    }
    let finalName = name;
    let n = 2;
    while (room.players.some((p) => p.name === finalName)) finalName = `${name} ${n++}`;
    player = {
      id: crypto.randomBytes(4).toString('hex'),
      token,
      name: finalName,
      chips: START_CHIPS,
      rebuys: 0,
      bet: 0,
      extra: 0,
      bonus: 0,
      bonusResult: null,
      fees: 0,
      drew: false,
      bought: false,
      confirmed: false,
      hand: null,
      decision: null,
      result: null,
      ws,
    };
    room.players.push(player);
    sysChat(room, `${player.name} הצטרף/ה לשולחן`);
  }
  ws.ctx = { room, player };
  checkProgress(room);
  broadcast(room);
}

// פינג כדי לזהות חיבורים מתים
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 25000);

// ניקוי חדרים ישנים
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyOnline = room.players.some((p) => p.ws && p.ws.readyState === 1);
    if (!anyOnline && now - room.lastActive > 30 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`Russian Poker server on :${PORT}`));
