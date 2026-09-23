// 브라우저 단독 실행판: 서버 없이 같은 World 를 브라우저 안에서 돌리고, WebSocket 과 같은 모양의 객체로 연결한다.
// 캐릭터는 이 브라우저의 localStorage 에 저장된다(사용할 수 없으면 저장 없이 진행).
import { AUTOSAVE_MS, TICK_MS } from "../shared/balance";
import type { ServerMsg } from "../shared/types";
import { parseClientMessage } from "../shared/validate";
import { World, type CharacterSave } from "../server/world";

const key = (name: string) => `pungunrok:char:${name}`;

function load(name: string): CharacterSave | null {
  try {
    const raw = localStorage.getItem(key(name));
    const c = raw ? (JSON.parse(raw) as CharacterSave) : null;
    return c && c.name === name ? c : null;
  } catch {
    return null;
  }
}

function store(c: CharacterSave) {
  try {
    localStorage.setItem(key(c.name), JSON.stringify(c));
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 창 등)에서는 저장 없이 진행
  }
}

export class LocalSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly world = new World({ now: Date.now() });
  private playerId: number | null = null;

  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
    setInterval(() => this.tick(), TICK_MS);
    setInterval(() => this.save(), AUTOSAVE_MS);
    window.addEventListener("pagehide", () => this.save());
  }

  send(data: string) {
    const r = parseClientMessage(data);
    if (!r.ok) return this.emit({ t: "error", code: r.code, message: r.message });
    const now = Date.now();
    if (r.msg.t === "login") {
      if (this.playerId !== null) return this.emit({ t: "error", code: "already_logged_in", message: "이미 접속 중입니다" });
      const p = this.world.addPlayer(load(r.msg.name) ?? World.newCharacter(r.msg.name, r.msg.job), now);
      this.playerId = p.id;
      this.emit(this.world.welcome(p));
      this.emit(this.world.snapshot(p.map));
      this.flush();
      this.save();
      return;
    }
    if (this.playerId === null) return this.emit({ t: "error", code: "not_logged_in", message: "먼저 로그인하세요" });
    this.world.handle(this.playerId, r.msg, now);
    this.flush();
  }

  close() {}

  private me() {
    return this.playerId === null ? undefined : this.world.players.get(this.playerId);
  }

  private emit(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  private tick() {
    const now = Date.now();
    this.world.tick(now);
    const p = this.me();
    if (p) this.emit(this.world.snapshot(p.map));
    this.flush();
  }

  private flush() {
    const p = this.me();
    for (const o of this.world.drain()) {
      if (!p) continue;
      if ((o.to === "player" && o.id === p.id) || (o.to === "map" && o.map === p.map)) this.emit(o.msg);
    }
    if (p?.dirty) {
      p.dirty = false;
      this.emit(this.world.selfMsg(p, Date.now()));
    }
  }

  private save() {
    const p = this.me();
    if (p) store(this.world.toSave(p));
  }
}
