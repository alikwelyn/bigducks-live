// Prova de roteamento: WS no hub + bridge-event -> mensagem chega no peer.
const base = process.argv[2] || "ws://127.0.0.1:8798";
const http = require("http");

const ws = new (require("ws"))(base + "/hub");
ws.on("message", (m) => {
  const text = m.toString();
  if (text.includes("stream-start")) {
    console.log("RECEBIDO NO HUB:", text.slice(0, 60));
    process.exit(0);
  }
});
ws.on("open", () => {
  http.get("http://127.0.0.1:" + new URL(base).port + "/bridge-event?name=stream-start&data=424242", (r) => r.resume());
});
setTimeout(() => { console.log("FALHOU: nada chegou em 4s"); process.exit(1); }, 4000);
