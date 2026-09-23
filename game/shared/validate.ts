// 클라이언트 메시지 스키마 검증. 서버는 이 함수를 통과한 메시지만 처리한다.
import { CHAT_MAX, INVENTORY_SIZE } from "./balance";
import { DIRS, JOBS, type ClientMsg, type Dir, type Job } from "./types";

export const NAME_RE = /^[가-힣A-Za-z0-9]{2,12}$/;
export const MAX_MESSAGE_BYTES = 2048;

export type ParseResult = { ok: true; msg: ClientMsg } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): ParseResult => ({ ok: false, code, message });
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function parseClientMessage(raw: unknown): ParseResult {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : null;
  if (text === null) return fail("bad_json", "텍스트 메시지만 허용됩니다");
  if (text.length > MAX_MESSAGE_BYTES) return fail("too_large", "메시지가 너무 깁니다");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("bad_json", "JSON 형식이 아닙니다");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return fail("bad_json", "객체가 아닙니다");
  const o = data as Record<string, unknown>;
  switch (o.t) {
    case "login":
      if (typeof o.name !== "string" || !NAME_RE.test(o.name)) return fail("bad_login", "이름은 한글·영문·숫자 2~12자입니다");
      if (!JOBS.includes(o.job as Job)) return fail("bad_login", "알 수 없는 직업입니다");
      return { ok: true, msg: { t: "login", name: o.name, job: o.job as Job } };
    case "move":
      if (!DIRS.includes(o.dir as Dir)) return fail("bad_dir", "잘못된 방향입니다");
      return { ok: true, msg: { t: "move", dir: o.dir as Dir } };
    case "attack":
    case "pickup":
    case "talk":
    case "unequip":
      return { ok: true, msg: { t: o.t } };
    case "skill":
      if (!isInt(o.slot, 1, 9)) return fail("bad_skill", "잘못된 스킬 번호입니다");
      return { ok: true, msg: { t: "skill", slot: o.slot } };
    case "chat": {
      if (typeof o.text !== "string") return fail("bad_chat", "채팅은 문자열이어야 합니다");
      if (o.text.length > CHAT_MAX) return fail("bad_chat", `채팅은 ${CHAT_MAX}자까지입니다`);
      if (o.text.trim().length === 0) return fail("bad_chat", "빈 채팅은 보낼 수 없습니다");
      return { ok: true, msg: { t: "chat", text: o.text } };
    }
    case "use":
      if (!isInt(o.slot, 0, INVENTORY_SIZE - 1)) return fail("bad_slot", "잘못된 인벤토리 칸입니다");
      return { ok: true, msg: { t: "use", slot: o.slot } };
    case "buy":
      if (!isStr(o.npc, 32) || !isStr(o.item, 32) || !isInt(o.qty, 1, 99)) return fail("bad_buy", "잘못된 구매 요청입니다");
      return { ok: true, msg: { t: "buy", npc: o.npc, item: o.item, qty: o.qty } };
    case "sell":
      if (!isStr(o.npc, 32) || !isInt(o.slot, 0, INVENTORY_SIZE - 1) || !isInt(o.qty, 1, 99)) return fail("bad_sell", "잘못된 판매 요청입니다");
      return { ok: true, msg: { t: "sell", npc: o.npc, slot: o.slot, qty: o.qty } };
    case "debug":
      if (o.cmd !== "spawn" || !isStr(o.kind, 32)) return fail("bad_debug", "잘못된 디버그 명령입니다");
      return { ok: true, msg: { t: "debug", cmd: "spawn", kind: o.kind } };
    default:
      return fail("unknown_type", "알 수 없는 메시지 종류입니다");
  }
}
