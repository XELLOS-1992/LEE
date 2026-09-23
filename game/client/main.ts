// 브라우저 클라이언트: 서버 상태를 받아 캔버스에 그리고, 키 입력을 서버 명령으로 보낸다.
import { ITEMS, MONSTERS, MOVE_INTERVAL_MS, SKILLS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import {
  JOB_NAMES, type ClientMsg, type DialogMsg, type Dir, type FxMsg, type ServerMsg, type SelfMsg, type SnapshotMsg,
  type WelcomeMsg,
} from "../shared/types";
import { approach, computeCamera, type Camera } from "./camera";
import { keyToAction } from "./input";
import { T } from "../shared/mapgen";
import { edgeMask, findBuildings, findProps, groundOf, type Building, type Prop } from "./scenery";
import {
  TILE, buildingSprite, drawSprite, groundSprite, itemIcon, itemSprite, monsterSprite, npcSprite, playerSprite, rockSprite,
  treeSprite,
} from "./sprites";

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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  renderStats.view = { w: VIEW_W, h: VIEW_H, zoom: ZOOM };
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface ChatLine { from: string; text: string; kind: "chat" | "system" | "error"; at?: number }
interface FloatFx { x: number; y: number; text: string; kind: "dmg" | "hurt" | "heal" | "level" | "skill" | "info"; born: number; life: number }
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
  levelups: [] as { x: number; y: number; born: number }[],
  sent: {} as Record<string, number>,
};

const renderStats = {
  frames: 0, tiles: 0, players: 0, monsters: 0, npcs: 0, items: 0, nameplates: 0, hpBars: 0,
  hud: false, chatBox: false, camera: { x: 0, y: 0 }, meScreen: { x: 0, y: 0 }, view: { w: 0, h: 0, zoom: 1 },
};

const visuals = new Map<string, Visual>();
let ws: WebSocket | null = null;

// ---------- 네트워크 ----------

function send(msg: ClientMsg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  state.sent[msg.t] = (state.sent[msg.t] ?? 0) + 1;
  ws.send(JSON.stringify(msg));
}

function connect(name: string, job: string) {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  // 단일 파일판(offline.ts)은 서버 대신 브라우저 안의 월드로 연결하는 함수를 넣어 둔다
  const create = (window as unknown as { __createSocket?: (u: string) => WebSocket }).__createSocket;
  ws = create ? create(url) : new WebSocket(url);
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
  state.chat.push({ ...line, at: performance.now() });
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
  const cx = fx.x * TILE + TILE / 2, cy = fx.y * TILE - 6;
  const mine = state.me && fx.target === `p:${state.me.id}`;
  const float = (text: string, kind: FloatFx["kind"], life = 1000, dy = 0) => state.floats.push({ x: cx, y: cy + dy, text, kind, born: now, life });
  switch (fx.kind) {
    case "hit":
      float(String(fx.amount), fx.target?.startsWith("p:") ? "hurt" : "dmg");
      state.swings.push({ x: fx.x, y: fx.y, born: now });
      break;
    case "miss":
      state.swings.push({ x: fx.x, y: fx.y, born: now });
      break;
    case "heal":
      if (fx.amount) float(`+${fx.amount}`, "heal");
      break;
    case "levelup":
      float("LEVEL UP!", "level", 1800, -18);
      state.levelups.push({ x: cx, y: fx.y * TILE + 30, born: now });
      break;
    case "skill":
      float(fx.text ?? "", "skill", 800, -26);
      break;
    case "kill":
      float(`${fx.text} 퇴치!`, "info", 1100, -14);
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
      const icon = itemIcon(slot.item);
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

const FONT = '"Noto Sans KR", "Malgun Gothic", sans-serif';
const CUTE = '"Jua", "Noto Sans KR", "Malgun Gothic", sans-serif';

interface MapArt {
  ground: number[][];
  masks: number[][];
  buildings: Building[];
  props: Prop[];
  minimap: HTMLCanvasElement;
}
const mapArts = new Map<string, MapArt>();

const PATH_FAMILY = new Set<number>([T.ROAD, T.DIRT, T.PORTAL, T.BRIDGE]);
const WATER_FAMILY = new Set<number>([T.WATER, T.BRIDGE]);
const MINI: Record<number, string> = {
  [T.GRASS]: "#7ecb5c", [T.FLOWER]: "#7ecb5c", [T.ROAD]: "#efd9a6", [T.DIRT]: "#d6ab6c", [T.WATER]: "#5bbcec",
  [T.BRIDGE]: "#c98a4e", [T.TREE]: "#3a9a48", [T.WALL]: "#9a8d78", [T.THATCH]: "#f0c864", [T.GIWA]: "#4f6488",
  [T.PORTAL]: "#b58cff", [T.CAVE]: "#8a7b9c", [T.ROCK]: "#5c526e",
};

function mapArt(id: string): MapArt {
  let a = mapArts.get(id);
  if (a) return a;
  const m = MAPS[id];
  const ground = m.tiles.map((row) => row.map((t) => groundOf(t, m.id === "cave")));
  const masks = ground.map((row, y) =>
    row.map((t, x) =>
      PATH_FAMILY.has(t) && t !== T.BRIDGE
        ? edgeMask(ground, x, y, (u) => PATH_FAMILY.has(u))
        : WATER_FAMILY.has(t)
          ? edgeMask(ground, x, y, (u) => WATER_FAMILY.has(u))
          : 0,
    ),
  );
  const minimap = document.createElement("canvas");
  minimap.width = m.width * 3;
  minimap.height = m.height * 3;
  const g = minimap.getContext("2d")!;
  m.tiles.forEach((row, y) =>
    row.forEach((t, x) => {
      g.fillStyle = MINI[t] ?? "#7ecb5c";
      g.fillRect(x * 3, y * 3, 3, 3);
    }),
  );
  a = { ground, masks, buildings: findBuildings(m.tiles), props: findProps(m.tiles), minimap };
  mapArts.set(id, a);
  return a;
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

function roundBox(x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient, stroke?: string, lw = 1.5) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/** 윤이 나는 게이지 */
function gauge(x: number, y: number, w: number, h: number, ratio: number, top: string, bottom: string, text?: string) {
  roundBox(x, y, w, h, h / 2, "rgba(10,14,28,0.75)", "#0b0f1c", 1.5);
  const r = Math.max(0, Math.min(1, ratio));
  if (r > 0) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    roundBox(x + 1.5, y + 1.5, Math.max(h - 3, (w - 3) * r), h - 3, (h - 3) / 2, g);
    roundBox(x + 4, y + 2.5, Math.max(0, (w - 8) * r), (h - 3) * 0.3, 2, "rgba(255,255,255,0.45)");
  }
  if (text) {
    ctx.font = `bold ${Math.round(h * 0.72)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.strokeText(text, x + w / 2, y + h / 2 + 0.5);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  }
}

/** 캐릭터 발밑의 이름표 */
function nameTag(text: string, x: number, y: number, color = "#ffffff", bg = "rgba(20,20,30,0.62)") {
  ctx.font = `bold 11px ${FONT}`;
  const w = ctx.measureText(text).width + 10;
  roundBox(x - w / 2, y, w, 15, 4, bg);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 8);
}

function outlined(text: string, x: number, y: number, size: number, fill: string | CanvasGradient, stroke = "#3a1a00", lw = 4) {
  ctx.font = `${size}px ${CUTE}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

const FLOAT_COLORS: Record<FloatFx["kind"], [string, string, string]> = {
  dmg: ["#fff7b0", "#ff9a1a", "#5a2400"],
  hurt: ["#ffd0ec", "#c2327a", "#3a0a24"],
  heal: ["#d8ffd0", "#34c04a", "#0a3a14"],
  level: ["#fffbe0", "#ffc21a", "#6a3a00"],
  skill: ["#e8f8ff", "#58b8ff", "#0a2a4a"],
  info: ["#ffffff", "#ffe6a8", "#3a2a10"],
};

function drawFloat(f: FloatFx, now: number, cam: Camera) {
  const t = (now - f.born) / f.life;
  const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.7 : t < 0.22 ? 1.3 - ((t - 0.12) / 0.1) * 0.3 : 1;
  const size = (f.kind === "level" ? 26 : f.kind === "dmg" || f.kind === "hurt" ? 22 : 15) * pop;
  const x = f.x - cam.x, y = f.y - cam.y - t * 28;
  const [a, b, s] = FLOAT_COLORS[f.kind];
  const g = ctx.createLinearGradient(0, y - size, 0, y);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.globalAlpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
  outlined(f.text, x, y, size, g, s, size > 18 ? 5 : 3.5);
  ctx.globalAlpha = 1;
}

/** 타격 순간의 별 모양 불꽃 */
function drawSpark(x: number, y: number, t: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 1 - t;
  ctx.strokeStyle = "#fff6b0";
  ctx.lineWidth = 3 * (1 - t) + 1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const r0 = 4 + t * 10, r1 = 10 + t * 16;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 6 * (1 - t) + 2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

/** 레벨업: 금빛 기둥과 퍼지는 고리 */
function drawLevelUp(x: number, y: number, t: number) {
  ctx.save();
  ctx.globalAlpha = 1 - t;
  const g = ctx.createLinearGradient(0, y - 90, 0, y);
  g.addColorStop(0, "rgba(255,230,120,0)");
  g.addColorStop(1, "rgba(255,210,80,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(x - 16, y - 90, 32, 90);
  ctx.strokeStyle = "#ffe066";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(x, y, 10 + t * 30, 4 + t * 10, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPortal(x: number, y: number, now: number) {
  const cx = x + TILE / 2, cy = y + TILE / 2 + 4;
  const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 18);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.4, "rgba(190,150,255,0.8)");
  g.addColorStop(1, "rgba(120,80,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 16, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const a = now / 400 + (i / 5) * Math.PI * 2;
    const rise = ((now / 25 + i * 37) % 30);
    ctx.fillStyle = `rgba(255,255,255,${0.9 - rise / 34})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 10, cy - rise + Math.sin(a) * 3, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
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

  ctx.fillStyle = "#1a2a1a";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const snap = state.snapshot;
  const me = state.me;
  if (!snap || !me) {
    drawTitleBackground(now);
    return;
  }
  const map = MAPS[snap.map];
  const art = mapArt(map.id);
  const meView = snap.players.find((p) => p.id === me.id);
  const meVis = meView ? visual(`p:${meView.id}`, meView.x, meView.y, dt) : { x: 0, y: 0, moving: 0 };
  const cam = computeCamera(meVis.x, meVis.y, map.width * TILE, map.height * TILE, VIEW_W, VIEW_H, TILE);
  renderStats.camera = cam;
  renderStats.meScreen = { x: meVis.x - cam.x, y: meVis.y - cam.y };

  // 지면
  const x0 = Math.max(0, Math.floor(cam.x / TILE)), x1 = Math.min(map.width - 1, Math.floor((cam.x + VIEW_W) / TILE));
  const y0 = Math.max(0, Math.floor(cam.y / TILE)), y1 = Math.min(map.height - 1, Math.floor((cam.y + VIEW_H) / TILE));
  const waterFrame = Math.floor(now / 700) % 2;
  let tiles = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const t = art.ground[y][x];
      const variant = (x * 928371 + y * 1237) % 8;
      const s = groundSprite(t, variant, art.masks[y][x], WATER_FAMILY.has(t) ? waterFrame : 0);
      ctx.drawImage(s.c, x * TILE - cam.x, y * TILE - cam.y, TILE + 0.5, TILE + 0.5);
      tiles++;
    }
  renderStats.tiles = tiles;
  for (const p of map.portals) drawPortal(p.x * TILE - cam.x, p.y * TILE - cam.y, now);

  // 바닥 아이템
  renderStats.items = 0;
  for (const it of snap.items) {
    drawSprite(ctx, itemSprite(it.item), it.x * TILE - cam.x + 16, it.y * TILE - cam.y + 26 + Math.sin(now / 250 + it.id) * 2);
    renderStats.items++;
  }

  // y 순서로 그리는 개체들
  type Drawable = { y: number; draw: () => void; overlay?: () => void };
  const list: Drawable[] = [];
  let nameplates = 0, hpBars = 0, playersDrawn = 0, monstersDrawn = 0;
  const seen = new Set<string>();
  const inView = (px: number, py: number, pad = 64) =>
    px > cam.x - pad && px < cam.x + VIEW_W + pad && py > cam.y - pad && py < cam.y + VIEW_H + pad * 2;
  const walkFrame = (v: Visual) => (now - v.moving < 180 ? 1 + (Math.floor(now / 110) % 4) : 0) % 4;

  for (const b of art.buildings) {
    if (!inView(b.x * TILE, b.y * TILE, b.w * TILE + 64)) continue;
    list.push({ y: (b.y + b.h) * TILE, draw: () => drawSprite(ctx, buildingSprite(b), b.x * TILE - cam.x, b.y * TILE - cam.y) });
  }
  const blossom = map.kind === "town";
  for (const p of art.props) {
    if (!inView(p.x * TILE, p.y * TILE)) continue;
    const sprite = p.kind === "tree" ? treeSprite(p.variant, blossom && p.variant === 2) : rockSprite(p.variant);
    list.push({ y: (p.y + 1) * TILE - 1, draw: () => drawSprite(ctx, sprite, p.x * TILE - cam.x + 16, p.y * TILE - cam.y + 30) });
  }
  for (const n of map.npcs) {
    const sx = n.x * TILE - cam.x + 16, sy = n.y * TILE - cam.y + 30;
    list.push({
      y: n.y * TILE + 30,
      draw: () => {
        drawSprite(ctx, npcSprite(n.look, n.dir), sx, sy, 1, 1 + Math.sin(now / 500 + n.x) * 0.015);
        // 말풍선 표시
        roundBox(sx + 8, sy - 50, 14, 11, 4, "#ffffff", "#3a2a1a", 1);
        ctx.fillStyle = "#3a2a1a";
        ctx.font = `bold 9px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("…", sx + 15, sy - 45);
      },
      overlay: () => {
        nameTag(n.name, sx, sy + 3, "#ffe27a", "rgba(40,30,10,0.72)");
        nameplates++;
      },
    });
  }
  for (const m of snap.monsters) {
    const key = `m:${m.id}`;
    seen.add(key);
    const v = visual(key, m.x, m.y, dt);
    const sx = Math.round(v.x - cam.x) + 16, sy = Math.round(v.y - cam.y) + 30;
    const def = MONSTERS[m.kind];
    const squash = Math.sin(now / 160 + m.id) * 0.05;
    list.push({
      y: v.y + 30,
      draw: () => {
        drawSprite(ctx, monsterSprite(m.kind, m.dir, Math.floor(now / 300 + m.id) % 2), sx, sy, 1 + squash * 0.6, 1 - squash);
        monstersDrawn++;
      },
      overlay: () => {
        if (m.hp < m.maxHp) {
          gauge(sx - 16, sy - 44, 32, 6, m.hp / m.maxHp, "#ff8a7a", "#d8283a");
          hpBars++;
        }
        nameTag(`Lv.${def?.level ?? "?"} ${def?.name ?? m.kind}`, sx, sy + 3, "#ffffff", "rgba(60,20,20,0.6)");
        nameplates++;
      },
    });
  }
  for (const p of snap.players) {
    const key = `p:${p.id}`;
    seen.add(key);
    const isMe = p.id === me.id;
    const v = isMe ? meVis : visual(key, p.x, p.y, dt);
    const sx = Math.round(v.x - cam.x) + 16, sy = Math.round(v.y - cam.y) + 30;
    list.push({
      y: v.y + 30.5,
      draw: () => {
        if (p.dead) ctx.globalAlpha = 0.45;
        drawSprite(ctx, playerSprite(p.job, p.dir, walkFrame(v)), sx, sy, 1, 1 + Math.sin(now / 420 + p.id) * 0.015);
        ctx.globalAlpha = 1;
        playersDrawn++;
      },
      overlay: () => {
        gauge(sx - 15, sy - 54, 30, 5, p.hp / p.maxHp, "#8dff9a", "#1fae45");
        hpBars++;
        nameTag(p.name, sx, sy + 3, isMe ? "#ffffff" : "#d8f0ff", isMe ? "rgba(30,60,140,0.75)" : "rgba(20,20,30,0.62)");
        nameplates++;
      },
    });
  }
  list.sort((a, b) => a.y - b.y);
  for (const d of list) d.draw();
  for (const d of list) d.overlay?.();
  if (meView) seen.add(`p:${meView.id}`);
  for (const k of visuals.keys()) if (!seen.has(k)) visuals.delete(k);

  // 효과
  state.swings = state.swings.filter((s) => now - s.born < 260);
  for (const s of state.swings) drawSpark(s.x * TILE - cam.x + 16, s.y * TILE - cam.y + 14, (now - s.born) / 260);
  state.levelups = state.levelups.filter((l) => now - l.born < 1400);
  for (const l of state.levelups) drawLevelUp(l.x - cam.x, l.y - cam.y, (now - l.born) / 1400);
  state.floats = state.floats.filter((f) => now - f.born < f.life);
  for (const f of state.floats) drawFloat(f, now, cam);

  // 포털 안내
  if (meView) {
    for (const p of map.portals)
      if (Math.abs(p.x - meView.x) + Math.abs(p.y - meView.y) <= 3)
        nameTag(`▶ ${p.label}`, p.x * TILE - cam.x + 16, p.y * TILE - cam.y - 18, "#f0e4ff", "rgba(80,40,160,0.7)");
  }

  renderStats.players = playersDrawn;
  renderStats.monsters = monstersDrawn;
  renderStats.npcs = map.npcs.length;
  renderStats.nameplates = nameplates;
  renderStats.hpBars = hpBars;

  drawHud(map.id, now, snap);
  renderStats.frames++;
}

function drawHud(mapId: string, now: number, snap: SnapshotMsg) {
  const s = state.self;
  const me = state.me!;
  const st = s?.stats ?? me.stats;
  const map = MAPS[mapId];

  // 미니맵 (왼쪽 위)
  const art = mapArt(mapId);
  const mmW = 150, mmH = Math.round((150 * map.height) / map.width);
  roundBox(8, 8, mmW + 12, mmH + 34, 8, "rgba(20,28,48,0.82)", "#9fb4dc", 1.5);
  ctx.font = `15px ${CUTE}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffe27a";
  ctx.fillText(map.name, 16, 21);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(14, 32, mmW, mmH, 4);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art.minimap, 14, 32, mmW, mmH);
  ctx.imageSmoothingEnabled = true;
  const k = mmW / map.width;
  for (const p of map.portals) {
    ctx.fillStyle = "#e0c8ff";
    ctx.fillRect(14 + p.x * k - 1, 32 + p.y * k - 1, 3, 3);
  }
  for (const p of snap.players) {
    const mine = p.id === me.id;
    ctx.fillStyle = mine ? (Math.floor(now / 300) % 2 ? "#ffe066" : "#ff9a1a") : "#ffffff";
    ctx.beginPath();
    ctx.arc(14 + (p.x + 0.5) * k, 32 + (p.y + 0.5) * k, mine ? 3 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 하단 상태바
  const barH = 58, by = VIEW_H - barH;
  const bg = ctx.createLinearGradient(0, by, 0, VIEW_H);
  bg.addColorStop(0, "#3a4668");
  bg.addColorStop(1, "#1c2238");
  ctx.fillStyle = bg;
  ctx.fillRect(0, by, VIEW_W, barH);
  ctx.fillStyle = "#9fb4dc";
  ctx.fillRect(0, by, VIEW_W, 1.5);

  // 레벨 배지
  const lg = ctx.createLinearGradient(0, by + 6, 0, by + 42);
  lg.addColorStop(0, "#ffe27a");
  lg.addColorStop(1, "#f09a1a");
  roundBox(10, by + 6, 58, 36, 8, lg, "#6a3a00", 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#6a3a00";
  ctx.font = `bold 9px ${FONT}`;
  ctx.fillText("LV.", 39, by + 14);
  outlined(String(st.level), 39, by + 38, 22, "#ffffff", "#6a3a00", 4);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `bold 13px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(me.name, 76, by + 16);
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = "#b8c8e8";
  ctx.fillText(`${JOB_NAMES[me.job]} · 공 ${st.atk} 방 ${st.def} 술 ${st.mag}`, 76, by + 33);

  // 체력·마력
  const gx = Math.max(250, VIEW_W * 0.3), gw = Math.min(220, (VIEW_W - gx - 260) / 2);
  gauge(gx, by + 9, gw, 16, st.hp / st.maxHp, "#ff9a8a", "#e0283a", `HP ${st.hp} / ${st.maxHp}`);
  gauge(gx + gw + 10, by + 9, gw, 16, st.mp / st.maxMp, "#8ac8ff", "#2a60e0", `MP ${st.mp} / ${st.maxMp}`);
  // 전
  ctx.beginPath();
  ctx.arc(gx + 8, by + 38, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd84a";
  ctx.fill();
  ctx.strokeStyle = "#8a5a00";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#8a5a00";
  ctx.fillRect(gx + 6, by + 36, 4, 4);
  ctx.font = `bold 12px ${FONT}`;
  ctx.fillStyle = "#ffe9a8";
  ctx.textAlign = "left";
  ctx.fillText(`${(s?.gold ?? 0).toLocaleString()} 전`, gx + 20, by + 38);

  // 단축 슬롯: 스킬 1·2, 물약 Q
  const skills = SKILLS[me.job];
  const slots = [
    ...skills.map((sk, i) => ({ key: String(i + 1), name: sk.name, cd: (s?.cooldowns[i + 1] ?? 0) / sk.cooldownMs, color: "#58b8ff" })),
    { key: "Q", name: "물약", cd: 0, color: "#ff6a7a" },
  ];
  slots.forEach((slot, i) => {
    const x = VIEW_W - (slots.length - i) * 64 - 8, y = by + 6;
    const sg = ctx.createLinearGradient(0, y, 0, y + 40);
    sg.addColorStop(0, "#56648a");
    sg.addColorStop(1, "#2a3250");
    roundBox(x, y, 58, 40, 7, sg, "#9fb4dc", 1.5);
    roundBox(x + 4, y + 4, 12, 12, 3, slot.color);
    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#10203a";
    ctx.fillText(slot.key, x + 10, y + 10.5);
    ctx.fillStyle = "#ffffff";
    ctx.font = `12px ${CUTE}`;
    ctx.fillText(slot.name, x + 29, y + 28);
    if (slot.cd > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.moveTo(x + 29, y + 20);
      ctx.arc(x + 29, y + 20, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, slot.cd));
      ctx.closePath();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, 58, 40, 7);
      ctx.clip();
      ctx.fill();
      ctx.restore();
    }
  });

  // 경험치
  const ratio = Number.isFinite(st.expNext) ? st.exp / st.expNext : 1;
  gauge(4, VIEW_H - 11, VIEW_W - 8, 9, ratio, "#f4ff8a", "#9ad020", `EXP ${st.exp} / ${st.expNext} (${(ratio * 100).toFixed(1)}%)`);
  renderStats.hud = true;

  // 채팅창: 최근 대화만 보이고 오래된 줄은 흐려진다 (채팅 입력 중에는 모두 표시)
  const typing = !chatInput.classList.contains("hidden");
  const lines = state.chat.slice(-6).filter((l) => typing || now - (l.at ?? 0) < 20_000);
  const cw = Math.min(440, VIEW_W - 24), lh = 17;
  const ch = Math.max(1, lines.length) * lh + 10, cy = by - ch - 8;
  roundBox(8, cy, cw, ch, 8, "rgba(10,14,28,0.32)");
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (!lines.length) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText("Enter 를 눌러 대화하기", 16, cy + 13);
  }
  lines.forEach((l, i) => {
    const text = l.from ? `${l.from} : ${l.text}` : l.text;
    const max = Math.floor((cw - 20) / 13);
    const y = cy + 13 + i * lh;
    const age = now - (l.at ?? 0);
    ctx.globalAlpha = typing || age < 15_000 ? 1 : 1 - (age - 15_000) / 5000;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    const shown = text.length > max ? text.slice(0, max - 1) + "…" : text;
    ctx.strokeText(shown, 16, y);
    ctx.fillStyle = l.kind === "error" ? "#ff9a9a" : l.kind === "system" ? "#ffe27a" : "#ffffff";
    ctx.fillText(shown, 16, y);
    ctx.globalAlpha = 1;
  });
  renderStats.chatBox = true;

  if (s?.dead) {
    ctx.fillStyle = "rgba(40,20,60,0.4)";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    outlined("쓰러졌습니다…", VIEW_W / 2, VIEW_H / 2, 34, "#ffffff", "#3a1a4a", 6);
  }
}

function drawTitleBackground(now: number) {
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, "#8fd3ff");
  g.addColorStop(0.7, "#d8f1ff");
  g.addColorStop(1, "#bfe8a8");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  for (let i = 0; i < 6; i++) {
    const x = ((i * 260 + now / (40 + i * 6)) % (VIEW_W + 200)) - 100, y = 40 + ((i * 97) % Math.max(1, VIEW_H * 0.5));
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (const [dx, dy, r] of [[0, 0, 22], [24, -8, 28], [52, 0, 22], [26, 8, 24]]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#7ecb5c";
  ctx.beginPath();
  ctx.moveTo(0, VIEW_H);
  for (let x = 0; x <= VIEW_W; x += 40) ctx.lineTo(x, VIEW_H - 70 - Math.sin(x / 120) * 20);
  ctx.lineTo(VIEW_W, VIEW_H);
  ctx.fill();
}

resize();
window.addEventListener("resize", resize);
requestAnimationFrame(frame);

// 테스트·디버깅용 노출
(window as unknown as { __game: unknown }).__game = { state, renderStats, send };
