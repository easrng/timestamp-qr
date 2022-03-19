import { QrCode } from "./qr.js";
import routed from "./routing.js";
import { info, encodeDrand } from "./drand.js";
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
const base = location.origin + location.pathname + "#";
let id;

let currentDrand;
let lastDrandTime;
async function drand() {
  const thisTime =
    (Math.floor(Date.now() / 1000) - info.genesis_time) % info.period;
  if (thisTime > lastDrandTime) return;
  lastDrandTime = thisTime;
  const res = await (
    await fetch("https://drand.cloudflare.com/public/latest")
  ).json();
  currentDrand = await encodeDrand(res);
}
function generate(text) {
  console.log(text);
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  if (!id || canvas.width != qr.size) {
    canvas.width = canvas.height = qr.size;
    id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  for (let i = 0; i < qr.size; i++)
    for (let j = 0; j < qr.size; j++) {
      id.data[(i * qr.size + j) * 4 + 3] = qr.modules[i][j] ? 255 : 0;
    }
  ctx.putImageData(id, 0, 0);
}
async function update() {
  try {
    await drand();
  } catch (e) {
    console.error(e);
  }
  generate(base + Date.now().toString(36) + ":" + currentDrand);
  setTimeout(update, window.clockSpeed||5000);
}
routed.then(update);
