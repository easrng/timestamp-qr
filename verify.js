import Client, {HTTP} from "./drandClient.js";
import routed from "./routing.js";
import { info, encodeDrand } from "./drand.js?1";
const urls = ["https://api.drand.sh", "https://drand.cloudflare.com"];

const client = Client.wrap(HTTP.forURLs(urls, info.hash), {
  chainHash: info.hash,
});

async function main() {
  document.body.classList.remove("beforeload");
  document.body.classList.add("loading");
  if(typeof WebAssembly != "object"){
    document.body.textContent =  "Please enable WebAssembly. Some browsers may require JIT to be enabled for WebAssembly to work."
    document.body.classList.remove("loading");
    return
  }
  let [timestamp, drandRound, drandHash] = location.hash.slice(1).split(":");
  timestamp = parseInt(timestamp, 36);
  const res = await (await client).get(parseInt(drandRound, 36));
  if ((await encodeDrand(res)) !== drandRound + ":" + drandHash)
    throw new Error("");
  const drandTs =
    (info.genesis_time + info.period * parseInt(drandRound, 36)) * 1000;
  if (Math.abs(timestamp - drandTs) > info.period * 1000)
    console.log(
      "Timestamp",
      timestamp,
      "is too far from drand, changing to",
      (timestamp = drandTs)
    );
  document.querySelector("#time").textContent = new Date(
    timestamp
  ).toLocaleString();
  document.body.classList.remove("loading");
}
routed.then(main).catch((e) => {
  console.error(e);
  document.querySelector("#time").textContent =
    "There was an error validating the time.";
});
