# xingchiapi-free-bridge

Proxy kecil (loopback) yang memperbaiki error **`403 client_not_allowed`** dari
upstream OpenAI-compatible yang membatasi klien berdasarkan `User-Agent`,
supaya router seperti [9Router](https://github.com/decolua/9router) bisa
memakainya.

Tanpa dependency. Satu file. ~300 baris Node.js.

```
Tanpa bridge:   router (UA undici) ──────────────► upstream → 403 client_not_allowed
Dengan bridge:  router (UA undici) ─► bridge (menimpa UA) ─► upstream → 200
```

> Versi Inggris: [README.md](README.md)

---

## Masalahnya

Sebagian gateway hanya mau menerima trafik dari daftar klien "coding" tertentu.
`api.xingchiapi.com` salah satunya — jawabannya:

```json
HTTP 403
{"error":{"code":"client_not_allowed",
          "message":"本站仅支持编程客户端使用：Codex、Claude Code、OpenCode、…"}}
```

> "Situs ini hanya mendukung klien pemrograman … script, SDK langsung, dan
> klien chat pihak ketiga belum didukung."

Gerbangnya adalah header **`User-Agent`**. Router LLM memanggil upstream lewat
`fetch` Node (undici) yang mengirim `user-agent: node` — atau tidak sama sekali —
jadi setiap request ditolak **sebelum sampai ke model**.

Yang membuat ini menjengkelkan:

* Dashboard router melaporkannya sebagai `Invalid API key or base URL` atau
  `all accounts locked` — tidak ada petunjuk soal `User-Agent`.
* Logika retry membakar stok akun (di kasus kami 3 akun terkunci berderet,
  masing-masing cooldown 1–2 menit).
* Hampir semua router **tidak punya opsi header per-provider**. Di 9Router,
  `open-sse/executors/default.js` membangun header upstream hanya dari registry
  statis atau `runtimeTransport`:

  ```js
  buildHeaders(credentials, stream) {
    const headers = { "Content-Type": "application/json",
                      ...(rt ? rt.headers : this.config.headers) };
  ```

  `providerSpecificData` tidak pernah dibaca untuk header, dan dialog
  *Add OpenAI Compatible* tidak punya field "Extra Headers" (dicek pada
  9Router 0.5.116 dan 0.5.119).

Karena itu identitas harus diperbaiki **di depan** router → itulah bridge ini.

## Bukti terukur

API key sama, body sama, hanya `User-Agent` yang diubah — direproduksi dengan
`scripts/probe.js` ke `https://api.xingchiapi.com`:

| User-Agent                              | HTTP | Error                |
| --------------------------------------- | ---- | -------------------- |
| *(kosong / default undici)*             | 403  | `client_not_allowed` |
| `node`                                  | 403  | `client_not_allowed` |
| `curl/8.5.0`                            | 403  | `client_not_allowed` |
| `9router/0.5.119`                       | 403  | `client_not_allowed` |
| `codex_cli_rs/0.48.0`                   | 403  | `client_not_allowed` |
| `claude-cli/2.1.92 (external, sdk-cli)` | **200** | —                 |
| `opencode/0.15.0`                       | **200** | —                   |
| `hermes-agent/1.0`                      | **200** | —                   |
| `Cursor/1.0`                            | **200** | —                   |

Perhatikan jebakannya: `codex_cli_rs` disebut di dalam teks whitelist tapi tetap
**ditolak**. Jadi jangan anggap pesan itu spesifikasi literal — probe, jangan
menebak.

Lewat bridge, semuanya jadi 200 termasuk default undici, karena headernya
ditimpa.

## Cara kerja

```
router ──POST /chat/completions──► 127.0.0.1:8792 ──► api.xingchiapi.com
        (UA apa pun)                │
                                    ├─ buang: user-agent, host, content-length,
                                    │         connection, transfer-encoding, …
                                    ├─ timpa: user-agent: claude-cli/2.1.92
                                    │         x-app: cli
                                    └─ pipe body apa adanya (aman untuk SSE)
```

Poin desain yang penting untuk produksi:

* **Hanya loopback** (`127.0.0.1`) sebagai default. Bind ke `0.0.0.0` mengundang
  blokir IP — ini proxy untuk pernyataan identitas, simpan lokal.
* **`accept-encoding: identity`** di sisi upstream, dan header transport
  (`content-encoding`, `content-length`, `transfer-encoding`) dibuang dari
  respons, jadi pipe tetap byte-transparan. Tidak ada bug re-encode gzip, tidak
  ada truncation, tidak ada buffering token stream.
* **Tanpa timeout request/response** (`requestTimeout = 0`) — stream SSE LLM bisa
  diam berbulan-bulan di antara chunk. Ada batas keras terpisah (`timeoutMs`,
  default 10 menit) hanya untuk socket upstream.
* **Endpoint `/__health`** menjawab lokal tanpa menyentuh upstream, murah untuk
  watchdog.
* **Keep-alive pooling** (64 socket) sehingga hop tambahan ~1 ms, bukan TLS
  handshake baru setiap request.
* **Identitas bisa diubah** lewat `config.json` atau env — ganti `UA` saat
  upstream mengubah allowlist.

---

## ⭐ Cara input manual di 9Router (alur utama)

Ini bagian yang paling sering ditanya. Ikuti persis, tidak perlu sentuh database
sama sekali.

### Langkah 0 — pastikan bridge hidup

```bash
curl -s http://127.0.0.1:8792/__health
# {"ok":true,"upstream":"https://api.xingchiapi.com","userAgent":"claude-cli/…", …}
```

Kalau belum ada, install dulu (lihat bagian **Instalasi**).

### Langkah 1 — buat provider compatible

1. Buka dashboard 9Router → menu **Providers**
   (`http://<host>:20128/dashboard/providers`)
2. Pada bagian *Custom providers* klik tombol **Add OpenAI Compatible**
3. Isi form **Add OpenAI Compatible**:

   | Field di form              | Nilai                                  |
   | -------------------------- | -------------------------------------- |
   | **Name**                   | `XingchiApi` (label bebas)             |
   | **Prefix**                 | `xingchiapi` (bebas, unik)             |
   | **API Type**               | `Chat Completions`                     |
   | **Base URL**               | **`http://127.0.0.1:8792`**            |
   | **API Key (for Check)**    | key xingchi Anda (untuk tes koneksi)   |
   | **Model ID (optional)**    | kosongkan saja                         |

4. Klik **Check** → harus muncul hasil valid/OK
5. Klik **Create**

> **Penting soal Base URL:** cukup `http://127.0.0.1:8792` — **tanpa**
> `/chat/completions` dan **tanpa** `/v1`. 9Router sendiri yang menambahkan
> path-nya. Kalau Anda menulis path manual, hasilnya jadi
> `/chat/completions/chat/completions` dan akan 404.

> Bridge menerima `/chat/completions` **dan** `/v1/chat/completions`
> (keduanya sudah diuji 200), jadi tidak masalah kalau ada provider lain yang
> sudah menuliskan `/v1` di Base URL-nya.

### Langkah 2 — tambahkan API key xingchi

Setelah provider tercipta, Anda masuk ke halaman detail provider:

1. Klik tombol **Add API Key** (pada provider compatible, labelnya memang
   "Add API Key", bukan "Add Connection")
2. Modal **Add XingchiApi API Key**:
   - **Name** → misal `cyber`, `dora`, `trojan`, atau apa pun
   - **API Key** → paste key xingchi (`sk-...`)
3. Simpan. Ulangi untuk setiap akun/key yang Anda punya.

### Langkah 3 — tes dari dashboard

Klik **Test** pada kartu akun, atau gunakan tombol *Test all API Key
connections*. Hasil yang benar: status `active`, tanpa `errorCode`.

### Langkah 4 — pakai dari klien

Model akan muncul sebagai `xingchiapi/gpt-6-astra` dan `xingchiapi/gpt-6.1-sol`
(prefix Anda + `/` + model):

```bash
KEY=<key 9router Anda>            # dari Dashboard → Keys

curl -s http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"xingchiapi/gpt-6.1-sol",
       "messages":[{"role":"user","content":"balas: OK"}]}'
```

### Kalau provider sudah ada tapi masih 403

Tidak perlu hapus. Buka provider → **Edit** → ganti **Base URL** menjadi
`http://127.0.0.1:8792` → **Save** → **Test**.

9Router membaca setting provider pada setiap request, jadi **tanpa restart**.
Kalau masih menampilkan status terkunci, klik *Test* sekali; status lama
(`errorCode`, `modelLock_*`) akan diperbarui sendiri oleh router.

> ⚠️ **Jangan** mengedit tabel `providerConnections` di SQLite 9Router kalau
> masih ada jalan lewat UI. `json_set` yang salah pada blob `data` bisa
> menghapus field yang dibutuhkan executor (termasuk `apiKey`), dan gejalanya
> muncul sebagai *error autentikasi* — bukan error data. Ini sudah pernah
> kejadian saat pengembangan; skrip DB-nya sengaja dibuang dari repo ini.

### Router / SDK lain

Bridge ini cuma URL OpenAI-compatible biasa. Arahkan `base_url` apa pun ke
`http://127.0.0.1:8792`. Path (`/chat/completions`, `/models`,
`/responses`, …) diteruskan apa adanya. Contoh Python:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8792/v1",
    api_key="sk-key-xingchi-anda",
)
print(client.chat.completions.create(
    model="gpt-6.1-sol",
    messages=[{"role": "user", "content": "balas: OK"}],
).choices[0].message.content)
```

---

## Instalasi

Kebutuhan: Linux dengan systemd, Node.js ≥ 18. Tanpa dependency npm.

```bash
git clone https://github.com/trojan0tik/xingchiapi-free-bridge.git
cd xingchiapi-free-bridge
sudo ./scripts/install.sh
```

Default: user = `$SUDO_USER`, port `8792`, upstream `https://api.xingchiapi.com`,
identitas `claude-cli/2.1.92 (external, sdk-cli)`.

Ubah apa pun:

```bash
sudo PORT=8793 UA='opencode/0.15.0' XAPP='' ./scripts/install.sh
```

Verifikasi:

```bash
curl -s http://127.0.0.1:8792/__health
```

Hapus:

```bash
sudo ./scripts/uninstall.sh          # hapus unit + app dir
sudo KEEP_DATA=1 ./scripts/uninstall.sh   # sisakan app dir
```

### Jalankan tanpa systemd

```bash
PORT=8792 node proxy.js
```

## Pemakaian

```bash
# diagnosa: identitas mana yang diterima upstream
node scripts/probe.js --key sk-… --model gpt-6.1-sol

# buktikan injector bekerja: semua identitas harus 200
node scripts/probe.js --key sk-… --proxy http://127.0.0.1:8792
```

### Konfigurasi

Urutan resolusi: default bawaan → `config.json` (di app dir, atau
`/etc/xingchiapi-free-bridge/config.json`, atau `$CONFIG_FILE`) → environment.

| Key            | Env                    | Default                                 | Catatan                                     |
| -------------- | ---------------------- | --------------------------------------- | ------------------------------------------- |
| `host`         | `BIND_HOST`            | `127.0.0.1`                             | biarkan loopback                            |
| `port`         | `PORT`                 | `8792`                                  |                                             |
| `upstream`     | `UPSTREAM`             | `https://api.xingchiapi.com`            | prefix path di URL dipertahankan            |
| `userAgent`    | `UA`                   | `claude-cli/2.1.92 (external, sdk-cli)` | ini inti perbaikannya                       |
| `xApp`         | `XAPP`                 | `cli`                                   | isi kosong untuk membuang                   |
| `extraHeaders` | `EXTRA_HEADERS` (JSON) | `{}`                                    | mis. `{"originator":"codex_cli_rs"}`        |
| `timeoutMs`    | `UPSTREAM_TIMEOUT_MS`  | `600000`                                | batas socket upstream, bukan idle stream    |
| `logRequests`  | `LOG_REQUESTS=0`       | `true`                                  |                                             |

## Verifikasi deployment

```bash
KEY=sk-…   # key xingchi langsung (bukan key 9router)

# non-stream
curl -s http://127.0.0.1:8792/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"balas ok"}],"max_tokens":8}'

# streaming — harus datang bertahap, bukan sekaligus
curl -sN http://127.0.0.1:8792/chat/completions \
  -H "Authorization: Bearer ***" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"hitung 1-5"}],"stream":true}'

# tool calling
curl -s http://127.0.0.1:8792/chat/completions \
  -H "Authorization: Bearer ***" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"cuaca Bali?"}],
       "tools":[{"type":"function","function":{"name":"get_weather","description":"cuaca",
       "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
```

Sudah terbukti jalan: completion sekali-jalan, SSE bertahap, tool call,
listing `/models` — langsung ke bridge maupun lewat 9Router di `:20128` (native)
dan `:20130` (go) yang berbagi satu DB.

## Catatan operasional

* **Jangan** kembalikan Base URL router ke `https://api.xingchiapi.com` — itu
  jalur 403.
* **Jangan** bind bridge ke interface publik. Upstream bisa menganggap
  identitas palsu dari satu host dalam volume besar sebagai penyalahgunaan.
* Header identitas bisa berubah mengikuti kebijakan upstream. Kalau 403 muncul
  lagi, jalankan `scripts/probe.js` lalu perbarui `UA` / `XAPP` — tanpa ubah
  kode.
* Port bentrok adalah penyebab gagal install paling umum: pilih port loopback
  yang bebas (`ss -ltn | grep <port>`), jangan bergantung pada default.
* **Latensi upstream sangat tidak stabil** — akun/model yang sama terukur
  **2,5 detik** dan **96 detik** untuk request 5 token yang identik. Bridge
  tidak memasang timeout pendek (batas 10 menit, stream tanpa batas idle), tapi
  *router* dengan request timeout 30 detik akan gagal acak dan melaporkannya
  sebagai error auth/koneksi. Naikkan timeout router, jangan salahkan bridge.
* Bridge tidak menyimpan kredensial. Kalau bridge mati, request gagal dengan
  `502 upstream error` / connection refused — penanganan key di router tidak
  terpengaruh. Cek `systemctl status xingchiapi-free-bridge` dan `bridge.log`.
* Kalau suatu saat upstream membatasi berdasarkan fingerprint TLS (bukan
  header), bridge ini tidak akan membantu; matriks probe akan menunjukkan
  *tidak ada* identitas yang diterima — itulah tanda untuk berhenti.

## Status yang sudah diuji

Diuji pada VPS Ubuntu x86_64, Node 22 & Node 20:

- `probe.js` langsung ke upstream → mereproduksi 403 vs 200 persis
- `probe.js` lewat bridge → 9/9 identitas 200
- SSE streaming lewat bridge → chunk bertahap, tidak dibuffer
- tool-calling lewat bridge → `tool_calls` kembali normal
- `install.sh` → service `active` + health check OK
- `uninstall.sh` → unit & app dir terhapus, service lain tidak tersentuh
- `/chat/completions`, `/v1/chat/completions`, `/models`, `/v1/models` → 200

## Disclaimer

Ini proxy penulisan ulang header. Ia tidak membuat akun, tidak melewati kuota,
dan tidak memberi hak yang tidak Anda miliki. Apakah pernyataan identitas klien
mematuhi ketentuan penyedia adalah urusan Anda dengan penyedia tersebut — daftar
whitelist di pesan error upstream dikutip di sini hanya sebagai bukti
diagnostik. Gunakan dengan risiko Anda sendiri.

## Lisensi

MIT
