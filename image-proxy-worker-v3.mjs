// Cloudflare Worker v3: proxy ảnh/trang cho Image Link Auto Inserter.
// Dùng: https://TEN.workers.dev/?key=MAT_KHAU&url=<link đã encode>
// QUAN TRỌNG: giữ nguyên mật khẩu cũ của bạn ở dòng KEY bên dưới.
const KEY = "doi-mat-khau-nay";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "cf-mitigated,x-upstream-status,x-upstream-variant,x-upstream-via,x-upstream-tried",
};
// v2 dùng Chrome/126 -> Fastly (radcliffecardiology) trả "403 old-browser". Giờ ưu tiên UA thật của trình duyệt gọi tới Worker.
const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function pickUA(req) {
  const ua = req.headers.get("user-agent") || "";
  return /Chrome\/\d+/.test(ua) && !/HeadlessChrome|bot|spider/i.test(ua) ? ua : FALLBACK_UA;
}

// Sinh danh sách URL thay thế cho cùng một ảnh (CDN gốc không có chống bot, bỏ token hết hạn...).
function buildCandidates(target) {
  const out = [target.href];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };

  // MDPI: www.mdpi.com chạy Akamai Bot Manager (chặn IP Cloudflare), ảnh bài báo còn nằm trên CDN pub.mdpi-res.com.
  if (/(^|\.)mdpi\.com$/.test(target.hostname) && /\/article_deploy\//.test(target.pathname)) {
    const base = "https://pub.mdpi-res.com" + target.pathname;
    add(base);
    // Nếu là bản thu nhỏ -550.jpg thì thử thêm bản gốc g001.png / .jpg
    const full = target.pathname.replace(/-550\.(jpe?g|png)$/i, ".png");
    if (full !== target.pathname) { add("https://pub.mdpi-res.com" + full); add("https://www.mdpi.com" + full); }
    const alt = target.pathname.replace(/\.png$/i, "-550.jpg");
    if (alt !== target.pathname) add("https://pub.mdpi-res.com" + alt);
  }
  // Link có query (VersionId, itok...): thử bản không query vì token có thể đã hết hạn.
  if (target.search) { const u = new URL(target.href); u.search = ""; add(u.href); }
  return out;
}

function buildHeaders(ua, ref, targetUrl) {
  const m = ua.match(/Chrome\/(\d+)/); const v = m ? m[1] : "154";
  const h = {
    "user-agent": ua,
    "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9,vi;q=0.8",
    "sec-ch-ua": `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not.A/Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "image",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": ref && new URL(ref).origin === targetUrl.origin ? "same-origin" : "cross-site",
  };
  if (ref) h.referer = ref;
  return h;
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const q = new URL(req.url).searchParams;
    if (q.get("key") !== KEY) return new Response("Sai key", { status: 403, headers: CORS });
    let target;
    try { target = new URL(q.get("url")); } catch { return new Response("URL lỗi", { status: 400, headers: CORS }); }
    if (!/^https?:$/.test(target.protocol)) return new Response("Chỉ http/https", { status: 400, headers: CORS });

    const ua = pickUA(req);
    const candidates = buildCandidates(target);
    const tried = [];
    let first = null, win = null, winIdx = -1, variant = 0;

    outer:
    for (let ci = 0; ci < candidates.length; ci++) {
      const cu = new URL(candidates[ci]);
      // Candidate gốc thử nhiều Referer; candidate phụ chỉ thử 2 kiểu để không quá số subrequest.
      const refs = ci === 0
        ? [q.get("ref"), cu.origin + "/", "", "https://www.google.com/"].filter((v, i) => i === 3 || v !== null)
        : [cu.origin + "/", ""];
      for (const ref of refs) {
        variant++;
        let res;
        try {
          res = await fetch(cu.href, {
            redirect: "follow", headers: buildHeaders(ua, ref, cu),
            cf: { cacheTtlByStatus: { "200-299": 3600, "400-599": 0 }, cacheEverything: true },
          });
        } catch (e) {
          res = new Response("Worker không kết nối được trang đích: " + e.message, { status: 502 });
        }
        tried.push(`${ci}:${res.status}`);
        if (!first) first = res;
        if (res.ok) { win = res; winIdx = ci; break outer; }
        if (![401, 403, 429, 503].includes(res.status)) break; // 404/410...: đổi candidate, không đổi Referer
      }
    }

    // Phương án cuối: bản lưu Wayback Machine (Worker gọi server-side nên không dính CORS).
    if (!win) {
      try {
        const wb = await fetch("https://web.archive.org/web/2id_/" + target.href, { redirect: "follow", headers: { "user-agent": ua } });
        tried.push("wb:" + wb.status);
        if (wb.ok) { win = wb; winIdx = 99; }
      } catch (e) { tried.push("wb:err"); }
    }

    const last = win || first;
    const h = new Headers(last.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    h.set("x-upstream-status", String(last.status));
    h.set("x-upstream-variant", String(variant));
    h.set("x-upstream-via", win ? (winIdx === 99 ? "wayback" : "candidate-" + winIdx) : "none");
    h.set("x-upstream-tried", tried.join(","));
    h.delete("content-security-policy"); h.delete("set-cookie");
    return new Response(last.body, { status: last.status, headers: h });
  },
};
