// 단일 파일판 진입점: 서버 대신 브라우저 안의 LocalSocket 으로 연결한다.
import { LocalSocket } from "./local-server";
import "./main";

(window as unknown as { __createSocket: () => LocalSocket }).__createSocket = () => new LocalSocket();

const note = document.createElement("p");
note.className = "offline-note";
note.textContent = "혼자 즐기는 브라우저판입니다. 진행 상황은 이 브라우저에 저장됩니다.";
document.getElementById("login-error")?.before(note);
