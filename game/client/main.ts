// 브라우저 클라이언트: 서버 상태를 받아 캔버스에 그리고, 키 입력을 서버 명령으로 보낸다.
import { ITEMS, MONSTERS, MOVE_INTERVAL_MS, SKILLS } from "../shared/balance";
import { MAPS, portalAt } from "../shared/maps";
import {
  JOB_NAMES, type ClientMsg, type DialogMsg, type Dir, type FxMsg, type ServerMsg, type SelfMsg, type SnapshotMsg,
  type WelcomeMsg,
} from "../shared/types";
import { approach, computeCamera } from "./camera";
import { keyToAction } from "./input";
import { TILE, itemSprite, monsterSprite, npcSprite, playerSprite, renderMapCanvas } from "./sprites";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
// 화면 크기: 캔버스는 브라우저 창 전체를 채우고, 보이는 범위가 대략 가로 26칸·세로 16칸이 되도록 확대한다.
const MIN_TILES_W = 26;
const MIN_TILES_H = 16;
let VIEW_W = canvas.width; // 게임 좌표계 기준 화면 크기(확대 전)
let VIEW_H = canvas.height;
let ZOOM = 1;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = window.innerWidth, cssH = window.innerHeight;
  // 0.25 단위로 맞춰 픽셀아트가 덜 일그러지게 한다
  ZOOM = Math.max(1, Math.floor(Math.min(cssW / (MIN_TILES_W * TILE), cssH / (MIN_TILES_H * TILE)) * 4) / 4);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  VIEW_W = Math.round(cssW / ZOOM);
  VIEW_H = Math.round(cssH / ZOOM);
  ctx.setTransform(ZOOM * dpr, 0, 0, ZOOM * dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  renderStats.view = { w: VIEW_W, h: VIEW_H, zoom: ZOOM };
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface ChatLine { from: string; text: string; kind: "chat" | "system" | "error" }
interface FloatFx { x: number; y: number; text: string; color: string; born: number; life: number }
interface Visual { x: number; y: number; moving: number }

const state = {
  connected: false,
  me: null as WelcomeMsg | null,
  self: null as SelfMsg | null,
  snapshot: null as SnapshotMsg | null,
  chat: [] as ChatLine[],
  dialog: null as DialogMsg | null,
  invOpen: false,
  floats: [] as FloatFx[],
  swings: [] as { x: number; y: number; born: number }[],
  sent: {} as Record<string, number>,
};

const renderStats = {
  frames: 0, tiles: 0, players: 0, monsters: 0, npcs: 0, items: 0, nameplates: 0, hpBars: 0,
  hud: false, chatBox: false, camera: { x: 0, y: 0 }, meScreen: { x: 0, y: 0 }, view: { w: 0, h: 0, zoom: 1 },
};

const visuals = new Map<string, Visual>();
const mapCanvases = new Map<string, HTMLCanvasElement>();
let ws: WebSocket | null = null;

// ---------- 네트워크 ----------

function send(msg: ClientMsg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  state.sent[msg.t] = (state.sent[msg.t] ?? 0) + 1;
  ws.send(JSON.stringify(msg));
}

function connect(name: string, job: string) {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    state.connected = true;
    send({ t: "login", name, job } as ClientMsg);
  };
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data as string) as ServerMsg);
    } catch (e) {
      console.error(e);
    }
  };
  ws.onclose = () => {
    state.connected = false;
    pushChat({ from: "", text: "서버와 연결이 끊어졌습니다. 새로고침하면 다시 접속합니다.", kind: "error" });
  };
}

function pushChat(line: ChatLine) {
  state.chat.push(line);
  if (state.chat.length > 50) state.chat.shift();
}

function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case "welcome":
      state.me = msg;
      $("login").classList.add("hidden");
      pushChat({ from: "", text: `${msg.name}님, ${MAPS[msg.map].name}에 오신 것을 환영합니다.`, kind: "system" });
      pushChat({ from: "", text: "방향키 이동 · Space 공격 · 1,2 스킬 · Z 줍기 · T 대화 · Q 물약 · I 소지품 · Enter 채팅", kind: "system" });
      break;
    case "self": {
      const prev = state.self;
      state.self = msg;
      if (prev && prev.map !== msg.map) pushChat({ from: "", text: `${MAPS[msg.map].name}(으)로 이동했습니다.`, kind: "system" });
      if (prev && msg.stats.level > prev.stats.level) pushChat({ from: "", text: `레벨 ${msg.stats.level}이 되었습니다!`, kind: "system" });
      if (!prev?.dead && msg.dead) pushChat({ from: "", text: "쓰러졌습니다... 잠시 후 졸본성에서 깨어납니다.", kind: "error" });
      if (state.invOpen) renderInventory();
      break;
    }
    case "snapshot":
      state.snapshot = msg;
      break;
    case "chat":
      pushChat({ from: msg.from, text: msg.text, kind: "chat" });
      break;
    case "error":
      if (!state.me) $("login-error").textContent = msg.message;
      else pushChat({ from: "", text: msg.message, kind: "error" });
      break;
    case "dialog":
      state.dialog = msg;
      renderDialog();
      break;
    case "fx":
      onFx(msg);
      break;
  }
}

function onFx(fx: FxMsg) {
  const now = performance.now();
  const cx = fx.x * TILE + TILE / 2, cy = fx.y * TILE;
  const mine = state.me && fx.target === `p:${state.me.id}`;
  switch (fx.kind) {
    case "hit":
      state.floats.push({ x: cx, y: cy, text: String(fx.amount), color: fx.target?.startsWith("p:") ? "#ff5a4a" : "#fff6d0", born: now, life: 900 });
      state.swings.push({ x: fx.x, y: fx.y, born: now });
      break;
    case "miss":
      state.swings.push({ x: fx.x, y: fx.y, born: now });
      break;
    case "heal":
      state.floats.push({ x: cx, y: cy, text: `+${fx.amount}`, color: "#7cff8a", born: now, life: 900 });
      break;
    case "levelup":
      state.floats.push({ x: cx, y: cy - 10, text: "LEVEL UP!", color: "#ffd84a", born: now, life: 1600 });
      break;
    case "skill":
      state.floats.push({ x: cx, y: cy - 16, text: fx.text ?? "", color: "#b8e0ff", born: now, life: 800 });
      break;
    case "kill":
      state.floats.push({ x: cx, y: cy, text: `${fx.text} 퇴치`, color: "#ffcf6a", born: now, life: 1000 });
      break;
    case "pickup":
      if (mine) pushChat({ from: "", text: `${fx.text}을(를) 주웠습니다.`, kind: "system" });
      break;
    default:
      break;
  }
}

// ---------- UI ----------

function renderDialog() {
  const d = state.dialog;
  const el = $("dialog");
  if (!d) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = "";
  const h = document.createElement("h3");
  h.textContent = d.name;
  const p = document.createElement("p");
  p.textContent = d.text;
  el.append(h, p);
  if (d.shop) {
    const shop = document.createElement("div");
    shop.className = "shop";
    for (const s of d.shop) {
      const name = document.createElement("span");
      name.textContent = ITEMS[s.item].name;
      const price = document.createElement("span");
      price.textContent = `${s.price}전`;
      const b = document.createElement("button");
      b.textContent = "사기";
      b.dataset.item = s.item;
      b.onclick = () => send({ t: "buy", npc: d.npc, item: s.item, qty: 1 });
      shop.append(name, price, b);
    }
    el.append(shop);
    const tip = document.createElement("div");
    tip.className = "help";
    tip.textContent = "소지품(I)을 열고 물건을 우클릭하면 팔 수 있습니다.";
    el.append(tip);
  }
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "닫기 (Esc)";
  close.onclick = () => { state.dialog = null; renderDialog(); };
  el.append(close);
}

function renderInventory() {
  const el = $("inventory");
  el.classList.toggle("hidden", !state.invOpen);
  const s = state.self;
  if (!state.invOpen || !s) return;
  $("inv-gold").textContent = `· ${s.gold}전`;
  const weapon = $("inv-weapon");
  weapon.innerHTML = "";
  const wl = document.createElement("div");
  wl.textContent = `무기: ${s.weapon ? ITEMS[s.weapon].name : "없음"} `;
  if (s.weapon) {
    const b = document.createElement("button");
    b.textContent = "해제";
    b.onclick = () => send({ t: "unequip" });
    wl.append(b);
  }
  weapon.append(wl);
  const grid = $("inv-grid");
  grid.innerHTML = "";
  s.inventory.forEach((slot, i) => {
    const d = document.createElement("div");
    d.className = "slot";
    d.dataset.slot = String(i);
    if (slot) {
      const icon = document.createElement("canvas");
      icon.width = TILE;
      icon.height = TILE;
      icon.getContext("2d")!.drawImage(itemSprite(slot.item), 0, 0);
      d.title = `${ITEMS[slot.item].name} (판매가 ${ITEMS[slot.item].sell}전)`;
      d.append(icon);
      if (slot.qty > 1) {
        const q = document.createElement("span");
        q.className = "qty";
        q.textContent = String(slot.qty);
        d.append(q);
      }
      d.onclick = () => send({ t: "use", slot: i });
      d.oncontextmenu = (e) => {
        e.preventDefault();
        if (state.dialog?.shop) send({ t: "sell", npc: state.dialog.npc, slot: i, qty: 1 });
      };
    }
    grid.append(d);
  });
}

const chatInput = $<HTMLInputElement>("chat-input");

function openChat() {
  chatInput.classList.remove("hidden");
  chatInput.value = "";
  chatInput.focus();
}

chatInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.isComposing) return;
  if (e.key === "Enter") {
    const text = chatInput.value;
    if (text.trim()) send({ t: "chat", text });
    chatInput.classList.add("hidden");
    chatInput.blur();
  } else if (e.key === "Escape") {
    chatInput.classList.add("hidden");
    chatInput.blur();
  }
});

// ---------- 입력 ----------

let heldDir: Dir | null = null;
let lastMoveSent = 0;
const held = new Set<string>();

function usePotion() {
  const s = state.self;
  if (!s) return;
  const lowHp = s.stats.hp / s.stats.maxHp <= s.stats.mp / Math.max(1, s.stats.maxMp);
  const order = lowHp ? ["potion_red", "potion_blue"] : ["potion_blue", "potion_red"];
  for (const id of order) {
    const i = s.inventory.findIndex((x) => x?.item === id);
    if (i >= 0) return send({ t: "use", slot: i });
  }
  pushChat({ from: "", text: "물약이 없습니다.", kind: "error" });
}

window.addEventListener("keydown", (e) => {
  if (!state.me || document.activeElement === chatInput) return;
  const action = keyToAction(e.code);
  if (!action) return;
  e.preventDefault();
  switch (action.type) {
    case "move":
      held.add(action.dir);
      heldDir = action.dir;
      if (!e.repeat) {
        send({ t: "move", dir: action.dir });
        lastMoveSent = performance.now();
      }
      break;
    case "attack":
      send({ t: "attack" });
      break;
    case "skill":
      send({ t: "skill", slot: action.slot });
      break;
    case "chat":
      openChat();
      break;
    case "inventory":
      state.invOpen = !state.invOpen;
      renderInventory();
      break;
    case "pickup":
      send({ t: "pickup" });
      break;
    case "talk":
      send({ t: "talk" });
      break;
    case "potion":
      usePotion();
      break;
    case "close":
      state.dialog = null;
      state.invOpen = false;
      renderDialog();
      renderInventory();
      break;
  }
});

window.addEventListener("keyup", (e) => {
  const a = keyToAction(e.code);
  if (a?.type === "move") {
    held.delete(a.dir);
    heldDir = held.size ? ([...held].pop() as Dir) : null;
  }
});
window.addEventListener("blur", () => { held.clear(); heldDir = null; });

$("start").addEventListener("click", () => {
  const name = $<HTMLInputElement>("name").value.trim();
  const job = $<HTMLSelectElement>("job").value;
  if (!/^[가-힣A-Za-z0-9]{2,12}$/.test(name)) {
    $("login-error").textContent = "이름은 한글·영문·숫자 2~12자로 지어 주세요.";
    return;
  }
  $("login-error").textContent = "접속 중...";
  connect(name, job);
});
$("name").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("start").click(); });

// ---------- 렌더링 ----------

function mapCanvas(id: string) {
  let c = mapCanvases.get(id);
  if (!c) {
    c = renderMapCanvas(MAPS[id].tiles);
    mapCanvases.set(id, c);
  }
  return c;
}

function visual(key: string, x: number, y: number, dt: number): Visual {
  const tx = x * TILE, ty = y * TILE;
  let v = visuals.get(key);
  if (!v) {
    v = { x: tx, y: ty, moving: 0 };
    visuals.set(key, v);
  }
  const step = (TILE / MOVE_INTERVAL_MS) * dt * 1.15;
  const moving = v.x !== tx || v.y !== ty;
  v.x = approach(v.x, tx, step, TILE * 3);
  v.y = approach(v.y, ty, step, TILE * 3);
  v.moving = moving ? performance.now() : v.moving;
  return v;
}

function bar(x: number, y: number, w: number, h: number, ratio: number, color: string, bg = "#2a1a12") {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.max(0, Math.min(1, ratio)) * w, h);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function label(text: string, x: number, y: number, color = "#fff", size = 12) {
  ctx.font = `${size}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

let lastFrame = performance.now();

function frame(now: number) {
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  requestAnimationFrame(frame);

  if (heldDir && now - lastMoveSent >= MOVE_INTERVAL_MS - 10) {
    send({ t: "move", dir: heldDir });
    lastMoveSent = now;
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const snap = state.snapshot;
  const me = state.me;
  if (!snap || !me) {
    drawTitleBackground(now);
    return;
  }
  const map = MAPS[snap.map];
  const meView = snap.players.find((p) => p.id === me.id);
  const meVis = meView ? visual(`p:${meView.id}`, meView.x, meView.y, dt) : { x: 0, y: 0, moving: 0 };
  const cam = computeCamera(meVis.x, meVis.y, map.width * TILE, map.height * TILE, VIEW_W, VIEW_H, TILE);
  renderStats.camera = cam;
  renderStats.meScreen = { x: meVis.x - cam.x, y: meVis.y - cam.y };

  ctx.drawImage(mapCanvas(map.id), -cam.x, -cam.y);
  renderStats.tiles = Math.ceil(VIEW_W / TILE + 1) * Math.ceil(VIEW_H / TILE + 1);

  // 포털 반짝임
  for (const p of map.portals) {
    const a = 0.35 + 0.25 * Math.sin(now / 200 + p.y);
    ctx.fillStyle = `rgba(170,140,255,${a})`;
    ctx.fillRect(p.x * TILE - cam.x + 4, p.y * TILE - cam.y + 4, TILE - 8, TILE - 8);
  }

  // 바닥 아이템
  renderStats.items = 0;
  for (const it of snap.items) {
    ctx.drawImage(itemSprite(it.item), it.x * TILE - cam.x, it.y * TILE - cam.y + Math.sin(now / 300 + it.id) * 2);
    renderStats.items++;
  }

  // y 정렬된 개체 그리기
  type Drawable = { y: number; draw: () => void };
  const list: Drawable[] = [];
  let nameplates = 0, hpBars = 0, playersDrawn = 0, monstersDrawn = 0;
  const seen = new Set<string>();
  const walkFrame = (v: Visual) => (now - v.moving < 180 ? Math.floor(now / 140) % 2 : 0);

  for (const n of map.npcs) {
    list.push({
      y: n.y * TILE,
      draw: () => {
        const sx = n.x * TILE - cam.x, sy = n.y * TILE - cam.y;
        ctx.drawImage(npcSprite(n.look, n.dir), sx, sy);
        label(n.name, sx + TILE / 2, sy - 2, "#ffe08a");
        nameplates++;
      },
    });
  }
  for (const m of snap.monsters) {
    const key = `m:${m.id}`;
    seen.add(key);
    const v = visual(key, m.x, m.y, dt);
    list.push({
      y: v.y,
      draw: () => {
        const sx = Math.round(v.x - cam.x), sy = Math.round(v.y - cam.y);
        ctx.drawImage(monsterSprite(m.kind, m.dir, Math.floor(now / 400 + m.id) % 2), sx, sy);
        if (m.hp < m.maxHp) { bar(sx + 4, sy - 4, TILE - 8, 4, m.hp / m.maxHp, "#e0403a"); hpBars++; }
        const def = MONSTERS[m.kind];
        label(`${def?.name ?? m.kind} Lv${def?.level ?? "?"}`, sx + TILE / 2, sy - 5, "#ffb0a0", 11);
        nameplates++;
        monstersDrawn++;
      },
    });
  }
  for (const p of snap.players) {
    const key = `p:${p.id}`;
    seen.add(key);
    const v = key === `p:${me.id}` ? meVis : visual(key, p.x, p.y, dt);
    list.push({
      y: v.y,
      draw: () => {
        const sx = Math.round(v.x - cam.x), sy = Math.round(v.y - cam.y);
        if (p.dead) ctx.globalAlpha = 0.4;
        ctx.drawImage(playerSprite(p.job, p.dir, walkFrame(v)), sx, sy);
        ctx.globalAlpha = 1;
        bar(sx + 4, sy - 5, TILE - 8, 4, p.hp / p.maxHp, "#3ad05a");
        hpBars++;
        label(`${p.name}`, sx + TILE / 2, sy - 6, p.id === me.id ? "#ffffff" : "#bfe3ff");
        nameplates++;
        playersDrawn++;
      },
    });
  }
  list.sort((a, b) => a.y - b.y);
  for (const d of list) d.draw();
  if (meView) seen.add(`p:${meView.id}`);
  for (const k of visuals.keys()) if (!seen.has(k)) visuals.delete(k);

  // 공격 궤적
  state.swings = state.swings.filter((s) => now - s.born < 200);
  for (const s of state.swings) {
    const t = (now - s.born) / 200;
    ctx.strokeStyle = `rgba(255,255,255,${1 - t})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x * TILE - cam.x + TILE / 2, s.y * TILE - cam.y + TILE / 2, 10 + t * 8, -1 + t * 2, 1 + t * 2);
    ctx.stroke();
  }

  // 떠오르는 숫자
  state.floats = state.floats.filter((f) => now - f.born < f.life);
  for (const f of state.floats) {
    const t = (now - f.born) / f.life;
    ctx.globalAlpha = 1 - t * t;
    label(f.text, f.x - cam.x, f.y - cam.y - t * 24, f.color, 14);
    ctx.globalAlpha = 1;
  }

  // 포털 안내
  if (meView) {
    for (const p of map.portals) {
      if (Math.abs(p.x - meView.x) + Math.abs(p.y - meView.y) <= 3 && portalAt(map, p.x, p.y))
        label(`→ ${p.label}`, p.x * TILE - cam.x + TILE / 2, p.y * TILE - cam.y - 4, "#d8c8ff");
    }
  }

  renderStats.players = playersDrawn;
  renderStats.monsters = monstersDrawn;
  renderStats.npcs = map.npcs.length;
  renderStats.nameplates = nameplates;
  renderStats.hpBars = hpBars;

  drawHud(map.name, now);
  renderStats.frames++;
}

function drawHud(mapName: string, now: number) {
  const s = state.self;
  const me = state.me!;
  // 상태창
  ctx.fillStyle = "rgba(20,14,8,0.82)";
  ctx.fillRect(8, 8, 300, 104);
  ctx.strokeStyle = "#b8914a";
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 300, 104);
  ctx.font = `bold 14px "Noto Sans KR", sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#f4ecd8";
  const st = s?.stats ?? me.stats;
  ctx.fillText(`${me.name}  ${JOB_NAMES[me.job]}  Lv.${st.level}`, 16, 14);
  ctx.font = `12px "Noto Sans KR", sans-serif`;
  bar(16, 36, 170, 12, st.hp / st.maxHp, "#d8363a");
  bar(16, 54, 170, 12, st.mp / st.maxMp, "#3a6ad8");
  bar(16, 72, 170, 8, Number.isFinite(st.expNext) ? st.exp / st.expNext : 1, "#e0c040");
  ctx.fillStyle = "#f4ecd8";
  ctx.fillText(`체력 ${st.hp}/${st.maxHp}`, 194, 35);
  ctx.fillText(`마력 ${st.mp}/${st.maxMp}`, 194, 53);
  ctx.fillText(`경험 ${Math.floor((st.exp / st.expNext) * 100) || 0}%`, 194, 69);
  ctx.fillText(`공 ${st.atk}  방 ${st.def}  술 ${st.mag}   ${s?.gold ?? 0}전`, 16, 88);
  renderStats.hud = true;

  // 맵 이름
  ctx.font = `bold 16px "Noto Sans KR", sans-serif`;
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(20,14,8,0.8)";
  ctx.fillRect(VIEW_W - 180, 8, 172, 28);
  ctx.fillStyle = "#ffe08a";
  ctx.fillText(mapName, VIEW_W - 16, 14);

  // 스킬 바
  const skills = SKILLS[me.job];
  skills.forEach((sk, i) => {
    const x = VIEW_W / 2 - skills.length * 44 + i * 88, y = VIEW_H - 52;
    ctx.fillStyle = "rgba(20,14,8,0.85)";
    ctx.fillRect(x, y, 84, 40);
    ctx.strokeStyle = "#b8914a";
    ctx.strokeRect(x, y, 84, 40);
    const cd = s?.cooldowns[i + 1] ?? 0;
    if (cd > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x, y, 84 * Math.min(1, cd / sk.cooldownMs), 40);
    }
    ctx.textAlign = "left";
    ctx.font = `12px "Noto Sans KR", sans-serif`;
    ctx.fillStyle = "#ffe08a";
    ctx.fillText(`${i + 1}`, x + 4, y + 4);
    ctx.fillStyle = "#f4ecd8";
    ctx.fillText(sk.name, x + 16, y + 4);
    ctx.fillStyle = "#9ab8ff";
    ctx.fillText(`마력 ${sk.mp}`, x + 16, y + 22);
  });

  // 채팅창
  const lines = state.chat.slice(-8);
  const boxH = 8 * 18 + 12;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(8, VIEW_H - boxH - 56, 440, boxH);
  ctx.font = `13px "Noto Sans KR", sans-serif`;
  ctx.textAlign = "left";
  lines.forEach((l, i) => {
    ctx.fillStyle = l.kind === "error" ? "#ff8a80" : l.kind === "system" ? "#ffe08a" : "#ffffff";
    const text = l.from ? `${l.from}: ${l.text}` : l.text;
    ctx.fillText(text.length > 52 ? text.slice(0, 51) + "…" : text, 14, VIEW_H - boxH - 50 + i * 18);
  });
  renderStats.chatBox = true;

  if (s?.dead) {
    ctx.fillStyle = "rgba(60,0,0,0.35)";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    label("쓰러졌습니다", VIEW_W / 2, VIEW_H / 2, "#ffb0a0", 28);
  }
  void now;
}

function drawTitleBackground(now: number) {
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, "#2a1e12");
  g.addColorStop(1, "#0e0a06");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  for (let i = 0; i < 40; i++) {
    const x = (i * 97 + now / 30) % VIEW_W, y = (i * 53) % VIEW_H;
    ctx.fillStyle = "rgba(216,178,90,0.15)";
    ctx.fillRect(x, y, 2, 2);
  }
}

resize();
window.addEventListener("resize", resize);
requestAnimationFrame(frame);

// 테스트·디버깅용 노출
(window as unknown as { __game: unknown }).__game = { state, renderStats, send };
