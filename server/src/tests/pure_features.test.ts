import { hashRoomPassword, verifyRoomPassword } from "../utils/roomPassword";
import { escapeHtml } from "../utils/escapeHtml";
import { parseIsoDuration } from "../controllers/youtube";

async function run() {
  const hash = await hashRoomPassword("secret");
  if (hash === "secret" || !(await verifyRoomPassword(hash, "secret"))) throw new Error("Room password hashing failed");
  if (await verifyRoomPassword(hash, "wrong")) throw new Error("Wrong room password was accepted");
  if (escapeHtml(`<b>"Tom" & 'Jerry'</b>`) !== "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;") throw new Error("HTML escaping failed");
  if (parseIsoDuration("PT1H2M3S") !== 3723 || parseIsoDuration("P1DT1S") !== 86401) throw new Error("YouTube duration parsing failed");
  console.log("Pure feature tests passed (password hashing, HTML escaping, YouTube durations).");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
