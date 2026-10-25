// Single-file field test page for proof-of-work (GPS + camera + resize + upload).
// No token is embedded: the user types it in, and it is only kept in this browser's localStorage.
// Note: the inline script avoids backticks and "${" because it lives inside a TS template literal.

export const TEST_CAMERA_CSP =
  "default-src 'self'; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'";

export const TEST_CAMERA_HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>owner-os · ทดสอบกล้อง + GPS</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font: 16px/1.45 system-ui, sans-serif; background: #f6f7f9; color: #1d2433; }
  main { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 4px 0 12px; }
  section { background: #fff; border-radius: 12px; padding: 12px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  h2 { font-size: 16px; margin: 0 0 8px; }
  label { display: block; font-size: 14px; margin: 8px 0 4px; }
  input[type=text], input[type=password] { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #c8cdd6; border-radius: 8px; }
  button, .file { display: block; width: 100%; min-height: 52px; margin-top: 10px; padding: 12px; font-size: 18px; font-weight: 600;
    border: 0; border-radius: 10px; background: #1f6feb; color: #fff; text-align: center; cursor: pointer; }
  button:disabled { background: #9aa4b2; }
  .file input { display: none; }
  .muted { color: #5b6475; font-size: 14px; }
  .out { margin-top: 8px; white-space: pre-wrap; word-break: break-word; }
  .ok { color: #116329; font-weight: 600; }
  .err { color: #b42318; font-weight: 600; }
  img { display: block; max-width: 100%; margin-top: 8px; border-radius: 8px; }
</style>
</head>
<body>
<main>
  <h1>ทดสอบส่งหลักฐานงาน</h1>

  <section>
    <h2>1. ตั้งค่า</h2>
    <label for="token">API token</label>
    <input id="token" type="password" autocomplete="off" placeholder="วาง token ที่นี่">
    <label for="wo">Work order id</label>
    <input id="wo" type="text" autocomplete="off" placeholder="เช่น 3f2a…">
    <p class="muted">ค่าทั้งสองถูกจำไว้ในเครื่องนี้เท่านั้น</p>
  </section>

  <section>
    <h2>2. พิกัด</h2>
    <button id="geo" type="button">ขอพิกัด</button>
    <div id="geoOut" class="out muted">ยังไม่มีพิกัด</div>
  </section>

  <section>
    <h2>3. รูปถ่าย</h2>
    <label class="file">ถ่าย / เลือกรูป
      <input id="photo" type="file" accept="image/*" capture="environment">
    </label>
    <div id="photoOut" class="out muted">ยังไม่มีรูป</div>
    <img id="preview" alt="" hidden>
  </section>

  <section>
    <h2>4. ส่ง</h2>
    <button id="send" type="button">ส่งหลักฐาน</button>
    <div id="sendOut" class="out"></div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var MAX_SIDE = 2048;
  var JPEG_QUALITY = 0.85;
  var $ = function (id) { return document.getElementById(id); };
  var state = { pos: null, blob: null, capturedAt: null, previewUrl: null };

  // Evidence already uploaded for the current photo + work order. A retry after a 422 (outside fence,
  // poor GPS, stale time) reuses it and only calls PUT /complete, so retries do not use up the quota.
  var uploadedEvidence = null; // { evidenceId, workOrderId }
  function rememberUploadedEvidence(evidenceId, workOrderId) {
    uploadedEvidence = { evidenceId: evidenceId, workOrderId: workOrderId };
  }
  function forgetUploadedEvidence() { uploadedEvidence = null; }
  function reusableEvidenceId(workOrderId) {
    return uploadedEvidence && uploadedEvidence.workOrderId === workOrderId ? uploadedEvidence.evidenceId : null;
  }

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }

  ["token", "wo"].forEach(function (id) {
    var el = $(id);
    el.value = load("owner-os." + id);
    el.addEventListener("input", function () {
      store("owner-os." + id, el.value.trim());
      if (id === "wo") forgetUploadedEvidence();
    });
  });

  function show(el, text, kind) {
    el.textContent = text;
    el.className = "out" + (kind ? " " + kind : "");
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isoWithOffset(d) {
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? "+" : "-";
    var abs = Math.abs(off);
    var ms = String(d.getMilliseconds()).padStart(3, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + ms +
      sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
  }

  function fmtBytes(n) {
    return n < 1024 * 1024 ? (n / 1024).toFixed(0) + " KB" : (n / 1024 / 1024).toFixed(2) + " MB";
  }

  // --- GPS ---
  $("geo").addEventListener("click", function () {
    var out = $("geoOut");
    if (!window.isSecureContext) {
      show(out, "ขอพิกัดไม่ได้: ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost", "err");
      return;
    }
    if (!navigator.geolocation) {
      show(out, "อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ GPS", "err");
      return;
    }
    show(out, "กำลังหาพิกัด… (สูงสุด 20 วินาที)", "muted");
    navigator.geolocation.getCurrentPosition(function (p) {
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy };
      show(out, "lat " + state.pos.lat.toFixed(6) + "\\nlng " + state.pos.lng.toFixed(6) +
        "\\nความคลาดเคลื่อน ±" + Math.round(state.pos.accuracy_m) + " ม.", "ok");
    }, function (err) {
      var msg = err.code === 1 ? "ถูกปฏิเสธสิทธิ์เข้าถึงตำแหน่ง — อนุญาต Location ในการตั้งค่าเบราว์เซอร์"
        : err.code === 3 ? "หาพิกัดไม่ทันใน 20 วินาที — ลองใหม่ในที่โล่ง"
        : "หาพิกัดไม่ได้ — ตรวจว่าเปิด GPS แล้ว";
      show(out, msg, "err");
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });

  // --- Photo: resize so the long side is <= 2048 px, re-encode as JPEG ---
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () { return decodeWithImg(file); });
    }
    return decodeWithImg(file);
  }
  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  $("photo").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    var out = $("photoOut");
    if (!file) return;
    forgetUploadedEvidence();
    state.capturedAt = isoWithOffset(new Date());
    state.blob = null;
    show(out, "กำลังย่อรูป…", "muted");
    decode(file).then(function (img) {
      var w = img.width, h = img.height;
      var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { show(out, "ย่อรูปไม่สำเร็จ", "err"); return; }
        state.blob = blob;
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = URL.createObjectURL(blob);
        $("preview").src = state.previewUrl;
        $("preview").hidden = false;
        show(out, canvas.width + "×" + canvas.height + " px · " + fmtBytes(blob.size) +
          " (เดิม " + fmtBytes(file.size) + ")\\nเวลาถ่าย " + state.capturedAt, "ok");
      }, "image/jpeg", JPEG_QUALITY);
    }).catch(function () { show(out, "เปิดไฟล์รูปนี้ไม่ได้", "err"); });
  });

  // --- Submit: ticket -> PUT image -> complete ---
  function explain(status, body) {
    var e = body && body.error;
    if (status === 401) return "API token ไม่ถูกต้อง";
    if (status === 503 && e === "auth_not_configured") return "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า API token";
    if (e === "work_order_not_found") return "ไม่พบงานนี้ — ตรวจ work order id";
    if (e === "evidence_not_found") return "ไม่พบหลักฐานของงานนี้";
    if (e === "work_order_not_active") return "งานนี้ไม่ได้เปิดรับหลักฐานแล้ว (ส่งไปแล้วหรือถูกปิด)";
    if (e === "evidence_already_uploaded") return "รูปนี้ถูกอัปโหลดไปแล้ว";
    if (e === "evidence_limit") return "งานนี้มีหลักฐานครบจำนวนสูงสุดแล้ว";
    if (e === "outside_geofence") return "อยู่นอกแปลง " + Math.round(body.distance_outside_m) + " ม.";
    if (e === "accuracy_too_low") return "GPS คลาด " + Math.round(state.pos ? state.pos.accuracy_m : 0) + " ม. ลองใหม่กลางแจ้ง";
    if (e === "captured_at_out_of_range") return "เวลาถ่ายเก่าเกิน 24 ชม. (หรือนาฬิกาเครื่องไม่ตรง) — ถ่ายรูปใหม่";
    if (e === "evidence_not_uploaded") return "รูปยังไม่ถึงเซิร์ฟเวอร์ — ลองส่งใหม่";
    if (e === "no_geofence") return "งานนี้ยังไม่มีขอบเขตแปลงให้ตรวจ";
    if (e === "unsupported_media_type") return "ชนิดไฟล์ไม่รองรับ";
    if (e === "payload_too_large") return "ไฟล์ใหญ่เกิน 10 MB";
    if (e === "validation_error") return "ข้อมูลที่ส่งไม่ถูกต้อง";
    if (status === 404) return "ไม่พบงานนี้";
    if (status === 409) return "งานนี้ไม่ได้เปิดรับหลักฐาน / อัปโหลดซ้ำ / ครบจำนวนแล้ว";
    return "เกิดข้อผิดพลาด (HTTP " + status + ")";
  }

  function call(method, path, token, body, contentType) {
    var headers = { "authorization": "Bearer " + token };
    if (contentType) headers["content-type"] = contentType;
    return fetch(path, { method: method, headers: headers, body: body }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) throw { status: res.status, body: data };
        return data;
      });
    });
  }

  $("send").addEventListener("click", function () {
    var out = $("sendOut");
    var token = $("token").value.trim();
    var wo = $("wo").value.trim();
    if (!token) return show(out, "กรอก API token ก่อน", "err");
    if (!wo) return show(out, "กรอก work order id ก่อน", "err");
    if (!state.pos) return show(out, "กด \\"ขอพิกัด\\" ก่อน", "err");
    if (!state.blob) return show(out, "ถ่ายหรือเลือกรูปก่อน", "err");

    var btn = $("send");
    btn.disabled = true;
    var base = "/api/tasks/" + encodeURIComponent(wo);
    var reuseId = reusableEvidenceId(wo);
    var uploaded;
    if (reuseId) {
      // Same photo, same work order: skip ticket + upload and only re-check with the latest position.
      uploaded = Promise.resolve(reuseId);
    } else {
      show(out, "1/3 ขอตั๋วอัปโหลด…", "muted");
      uploaded = call("POST", base + "/upload-ticket", token).then(function (ticket) {
        show(out, "2/3 อัปโหลดรูป " + fmtBytes(state.blob.size) + "…", "muted");
        return call("PUT", ticket.upload_url, token, state.blob, "image/jpeg").then(function () {
          rememberUploadedEvidence(ticket.evidence_id, wo);
          return ticket.evidence_id;
        });
      });
    }
    uploaded
      .then(function (evidenceId) {
        show(out, (reuseId ? "ส่งใหม่ด้วยรูปเดิม · " : "3/3 ") + "ตรวจพิกัด…", "muted");
        return call("PUT", base + "/complete", token, JSON.stringify({
          evidence_id: evidenceId,
          lat: state.pos.lat,
          lng: state.pos.lng,
          accuracy_m: state.pos.accuracy_m,
          captured_at: state.capturedAt
        }), "application/json");
      })
      .then(function (res) {
        forgetUploadedEvidence();
        var ev = res.evidence;
        var msg = ev.inside_geofence
          ? "ส่งสำเร็จ อยู่ในแปลง (ระยะนอกแปลง 0 ม.)"
          : "ส่งสำเร็จ อยู่ในแปลง (นอกขอบ " + Math.round(ev.distance_outside_m) + " ม. อยู่ในระยะเผื่อ)";
        show(out, msg + "\\nสถานะงาน: " + res.work_order.status, "ok");
      })
      .catch(function (err) {
        if (err && typeof err.status === "number") show(out, explain(err.status, err.body), "err");
        else show(out, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ต", "err");
      })
      .then(function () { btn.disabled = false; });
  });
})();
</script>
</body>
</html>
`;
