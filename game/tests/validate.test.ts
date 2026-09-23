import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../shared/validate";

const code = (raw: unknown) => {
  const r = parseClientMessage(raw);
  return r.ok ? "ok" : r.code;
};

describe("AC-17 메시지 스키마 검증", () => {
  it("AC-17 JSON 이 아니거나 객체가 아니면 거부한다", () => {
    expect(code("{not json")).toBe("bad_json");
    expect(code("[1,2]")).toBe("bad_json");
    expect(code("null")).toBe("bad_json");
    expect(code("42")).toBe("bad_json");
    expect(code(undefined)).toBe("bad_json");
    expect(code("x".repeat(5000))).toBe("too_large");
  });

  it("AC-17 알 수 없는 타입은 거부한다", () => {
    expect(code('{"t":"hack"}')).toBe("unknown_type");
    expect(code('{"t":123}')).toBe("unknown_type");
    expect(code("{}")).toBe("unknown_type");
    expect(code('{"t":"__proto__"}')).toBe("unknown_type");
  });

  it("AC-17 로그인: 이름 형식과 직업을 검사한다", () => {
    expect(code('{"t":"login","name":"홍길동","job":"warrior"}')).toBe("ok");
    expect(code('{"t":"login","name":"ab12","job":"poet"}')).toBe("ok");
    expect(code('{"t":"login","name":"가","job":"warrior"}')).toBe("bad_login");
    expect(code('{"t":"login","name":"가나다라마바사아자차카타파","job":"warrior"}')).toBe("bad_login");
    expect(code('{"t":"login","name":"<script>","job":"warrior"}')).toBe("bad_login");
    expect(code('{"t":"login","name":"홍 길동","job":"warrior"}')).toBe("bad_login");
    expect(code('{"t":"login","name":{"$gt":""},"job":"warrior"}')).toBe("bad_login");
    expect(code('{"t":"login","name":"홍길동","job":"god"}')).toBe("bad_login");
    expect(code('{"t":"login","name":"홍길동","job":["warrior"]}')).toBe("bad_login");
  });

  it("AC-17 이동·스킬·사용 등 숫자·열거형 필드를 검사한다", () => {
    expect(code('{"t":"move","dir":"up"}')).toBe("ok");
    expect(code('{"t":"move","dir":"diagonal"}')).toBe("bad_dir");
    expect(code('{"t":"move"}')).toBe("bad_dir");
    expect(code('{"t":"skill","slot":1}')).toBe("ok");
    expect(code('{"t":"skill","slot":1.5}')).toBe("bad_skill");
    expect(code('{"t":"skill","slot":"1"}')).toBe("bad_skill");
    expect(code('{"t":"skill","slot":0}')).toBe("bad_skill");
    expect(code('{"t":"use","slot":19}')).toBe("ok");
    expect(code('{"t":"use","slot":20}')).toBe("bad_slot");
    expect(code('{"t":"use","slot":-1}')).toBe("bad_slot");
    expect(code('{"t":"buy","npc":"jumo","item":"potion_red","qty":1}')).toBe("ok");
    expect(code('{"t":"buy","npc":"jumo","item":"potion_red","qty":0}')).toBe("bad_buy");
    expect(code('{"t":"buy","npc":"jumo","item":"potion_red","qty":1e9}')).toBe("bad_buy");
    expect(code('{"t":"sell","npc":"jumo","slot":0,"qty":-3}')).toBe("bad_sell");
  });

  it("AC-17 채팅: 문자열, 200자 이하, 공백만은 불가", () => {
    expect(code('{"t":"chat","text":"안녕하세요"}')).toBe("ok");
    expect(code('{"t":"chat","text":12345}')).toBe("bad_chat");
    expect(code('{"t":"chat","text":"   "}')).toBe("bad_chat");
    expect(code('{"t":"chat","text":""}')).toBe("bad_chat");
    expect(code(JSON.stringify({ t: "chat", text: "가".repeat(200) }))).toBe("ok");
    expect(code(JSON.stringify({ t: "chat", text: "가".repeat(201) }))).toBe("bad_chat");
  });

  it("AC-17 알려진 필드만 남기고 나머지는 버린다", () => {
    const r = parseClientMessage('{"t":"move","dir":"up","x":999,"hp":99999}');
    expect(r).toEqual({ ok: true, msg: { t: "move", dir: "up" } });
  });
});
